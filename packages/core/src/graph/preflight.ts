import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { StoreQueries } from "../store/queries";
import { getSnippet, createSnippetCache, formatRange, isTestFile } from "./utils";
import { ImpactAnalyzer } from "./impact";
import type { BoundaryConfig } from "../verify/checks/boundaries";

// ── Types ────────────────────────────────────────────────────────────

export interface PreflightCallSite {
  file: string;
  line: number;
  snippet: string;
}

export interface PreflightSymbol {
  name: string;
  kind: string;
  isExported: boolean;
  signature: string;
  callSites: PreflightCallSite[];
  testFiles: string[];
}

export interface PreflightBlastRadius {
  directDependents: number;
  transitiveDependents: number;
  riskCategory: "low" | "medium" | "high" | "critical";
}

export interface PreflightBoundary {
  layer: string;
  canImport: string[];
  violations: string[];
}

export interface PreflightResult {
  file: string;
  symbols: PreflightSymbol[];
  blastRadius: PreflightBlastRadius;
  boundaries: PreflightBoundary | null;
  checklist: string[];
}

export interface PreflightOptions {
  fast?: boolean;
}

// ── PreflightAnalyzer ────────────────────────────────────────────────

export class PreflightAnalyzer {
  constructor(
    private store: StoreQueries,
    private repoRoot: string,
  ) {}

  analyze(filePath: string, opts?: PreflightOptions): PreflightResult {
    const fast = opts?.fast ?? false;
    const snippetCache = createSnippetCache();

    // Get all symbols defined in this file, filtering out module-level symbols
    const fileSymbols = this.store.getSymbolsByFile(filePath).filter(
      (sym) => sym.kind !== undefined && sym.kind !== null && sym.kind !== "",
    );

    // Track all referencing files for blast radius
    const allRefFiles = new Set<string>();
    const allTestFiles = new Set<string>();

    // Build symbol results
    const symbols: PreflightSymbol[] = [];

    for (const sym of fileSymbols) {
      // Signature: first line of the symbol's definition
      let signature = "";
      if (sym.range_start != null) {
        const range = formatRange(sym.range_start, sym.range_end ?? sym.range_start);
        const snip = getSnippet(this.repoRoot, filePath, range.startLine, snippetCache);
        if (snip) {
          signature = snip.split("\n")[0];
        }
      }

      // Get occurrences
      const occs = this.store.getOccurrencesBySymbol(sym.id);
      const callSites: PreflightCallSite[] = [];
      const testFiles: string[] = [];
      const seenTestFiles = new Set<string>();
      let hasExternalRefs = false;

      for (const occ of occs) {
        if (occ.roles & 1) continue; // skip definitions

        // Track for blast radius
        if (occ.file_path !== filePath) {
          allRefFiles.add(occ.file_path);
          hasExternalRefs = true;
        }

        // Identify test files
        if (isTestFile(occ.file_path) && !seenTestFiles.has(occ.file_path)) {
          seenTestFiles.add(occ.file_path);
          testFiles.push(occ.file_path);
          allTestFiles.add(occ.file_path);
        }

        // Build call site (cap to 5 in fast mode)
        if (fast && callSites.length >= 5) continue;
        if (occ.file_path === filePath) continue; // skip self-references

        const range = formatRange(occ.range_start, occ.range_end);
        const snippet = getSnippet(
          this.repoRoot,
          occ.file_path,
          range.startLine,
          snippetCache,
        );

        callSites.push({
          file: occ.file_path,
          line: range.startLine,
          snippet: snippet ? snippet.split("\n")[0] : "",
        });
      }

      symbols.push({
        name: sym.name,
        kind: sym.kind ?? "unknown",
        isExported: hasExternalRefs,
        signature,
        callSites,
        testFiles,
      });
    }

    // Blast radius
    const directDependents = allRefFiles.size;
    let transitiveDependents = 0;
    let riskCategory: PreflightBlastRadius["riskCategory"];

    if (fast) {
      // Fast mode: skip transitive, infer risk from direct count
      transitiveDependents = directDependents;
      if (directDependents <= 2) riskCategory = "low";
      else if (directDependents <= 5) riskCategory = "medium";
      else if (directDependents <= 10) riskCategory = "high";
      else riskCategory = "critical";
    } else {
      // Full mode: use ImpactAnalyzer for accurate transitive count
      const impact = new ImpactAnalyzer(this.store, this.repoRoot);
      const transitiveResult = impact.computeTransitiveImpact([filePath], {
        maxDepth: 3,
      });
      transitiveDependents = transitiveResult.affectedFiles.length;
      riskCategory = transitiveResult.riskCategory as PreflightBlastRadius["riskCategory"];
      // Normalize risk category to our expected values
      if (!["low", "medium", "high", "critical"].includes(riskCategory)) {
        riskCategory = directDependents <= 2 ? "low" : "medium";
      }
    }

    const blastRadius: PreflightBlastRadius = {
      directDependents,
      transitiveDependents,
      riskCategory,
    };

    // Boundary check
    const boundaries = this._checkBoundary(filePath);

    // Build prescriptive checklist
    const checklist: string[] = [];

    for (const sym of symbols) {
      if (sym.isExported && sym.callSites.length > 0) {
        const uniqueFiles = [...new Set(sym.callSites.map((cs) => {
          const parts = cs.file.split("/");
          return parts[parts.length - 1];
        }))];
        checklist.push(
          `If you change '${sym.name}', update ${sym.callSites.length} call site${sym.callSites.length > 1 ? "s" : ""} in: ${uniqueFiles.join(", ")}`,
        );
      }
    }

    if (allTestFiles.size > 0) {
      checklist.push(`Run tests: ${[...allTestFiles].join(", ")}`);
    }

    if (riskCategory === "high" || riskCategory === "critical") {
      checklist.push(
        `Warning: ${riskCategory} blast radius (${directDependents} direct dependents)`,
      );
    }

    if (boundaries) {
      checklist.push(
        `Boundary: ${boundaries.layer} layer (can import: ${boundaries.canImport.join(", ") || "none"})`,
      );
      if (boundaries.violations.length > 0) {
        checklist.push(
          `Boundary violations: ${boundaries.violations.join(", ")}`,
        );
      }
    }

    return {
      file: filePath,
      symbols,
      blastRadius,
      boundaries,
      checklist,
    };
  }

  /** Check boundary config for the given file. */
  private _checkBoundary(filePath: string): PreflightBoundary | null {
    const configPath = join(this.repoRoot, "ariadne.boundaries.json");
    if (!existsSync(configPath)) return null;

    let config: BoundaryConfig;
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return null;
    }

    if (!config.layers || Object.keys(config.layers).length === 0) return null;

    // Sorted layers (longest prefix first) for most-specific match
    const sortedLayers = Object.entries(config.layers)
      .map(([name, def]) => ({
        name,
        prefix: def.path.endsWith("/") ? def.path : def.path + "/",
        canImport: def.canImport,
      }))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    // Find which layer this file belongs to
    let fileLayer: { name: string; canImport: string[] } | null = null;
    for (const layer of sortedLayers) {
      if (filePath.startsWith(layer.prefix)) {
        fileLayer = { name: layer.name, canImport: layer.canImport };
        break;
      }
    }

    if (!fileLayer) return null;

    // Check this file's imports for violations
    const violations: string[] = [];
    const edges = this.store.getEdgesBySource(filePath).filter(
      (e) => e.kind === "imports",
    );

    for (const edge of edges) {
      for (const layer of sortedLayers) {
        if (edge.target.startsWith(layer.prefix) || (edge.target + "/").startsWith(layer.prefix)) {
          if (layer.name !== fileLayer.name && !fileLayer.canImport.includes(layer.name)) {
            violations.push(`imports ${layer.name} (${edge.target})`);
          }
          break;
        }
      }
    }

    return {
      layer: fileLayer.name,
      canImport: fileLayer.canImport,
      violations,
    };
  }
}
