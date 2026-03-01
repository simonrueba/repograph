import { readFileSync } from "fs";
import { join } from "path";
import type { StoreQueries } from "../store/queries";
import { getSnippet, createSnippetCache, formatRange, isTestFile } from "./utils";

// ── Types ────────────────────────────────────────────────────────────

export interface ContextFileEntry {
  path: string;
  priority: number;
  depth: number;
  content: string;
  symbols: { name: string; kind: string; isExported: boolean }[];
  reason: string;
  tokenEstimate: number;
}

export interface ContextResult {
  files: ContextFileEntry[];
  totalTokens: number;
  truncated: boolean;
  entryFiles: string[];
  summary: string;
}

export interface ContextOptions {
  depth?: number;
  budget?: number;
  includeTests?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"];

function readFileSafe(repoRoot: string, filePath: string): string | null {
  try {
    return readFileSync(join(repoRoot, filePath), "utf-8");
  } catch {
    return null;
  }
}

// ── ContextCompiler ──────────────────────────────────────────────────

export class ContextCompiler {
  constructor(
    private store: StoreQueries,
    private repoRoot: string,
  ) {}

  compile(entryPaths: string[], opts?: ContextOptions): ContextResult {
    const depth = opts?.depth ?? 3;
    const budget = opts?.budget ?? 50000;
    const includeTests = opts?.includeTests ?? false;

    // Pre-build file set for O(1) lookups during target resolution
    const allFiles = this.store.getFilePaths();

    // Export edge lookup: files that are sources of export edges
    const exportEdges = this.store.getExportEdges();
    const exportedFiles = new Set<string>();
    for (const edge of exportEdges) {
      exportedFiles.add(edge.source);
    }

    // discovered: path → { priority, depth, reason }
    const discovered = new Map<string, { priority: number; depth: number; reason: string }>();

    // Seed entry files
    for (const ep of entryPaths) {
      if (allFiles.has(ep)) {
        discovered.set(ep, { priority: 1.0, depth: 0, reason: "entry file" });
      }
    }

    // BFS
    let frontier = new Set<string>(
      entryPaths.filter((p) => allFiles.has(p)),
    );

    for (let d = 1; d <= depth && frontier.size > 0; d++) {
      const nextFrontier = new Set<string>();

      for (const file of frontier) {
        // Forward: imports from this file
        const forwardEdges = this.store.getEdgesBySource(file).filter(
          (e) => e.kind === "imports",
        );
        for (const edge of forwardEdges) {
          const resolved = this._resolveTarget(edge.target, allFiles);
          if (resolved && !discovered.has(resolved)) {
            const testPenalty = !includeTests && isTestFile(resolved) ? 0.3 : 1.0;
            const priority = (1.0 / (1 + d)) * 1.0 * testPenalty;
            discovered.set(resolved, {
              priority,
              depth: d,
              reason: `imported by ${file}`,
            });
            nextFrontier.add(resolved);
          }
        }

        // Reverse: files that import this file
        const moduleName = file.replace(/\.[^.]+$/, "");
        const reverseEdges = this.store.getEdgesByTargetBatch([moduleName, file]);
        for (const edge of reverseEdges) {
          if (!discovered.has(edge.source)) {
            const testPenalty = !includeTests && isTestFile(edge.source) ? 0.3 : 1.0;
            const priority = (1.0 / (1 + d)) * 0.6 * testPenalty;
            discovered.set(edge.source, {
              priority,
              depth: d,
              reason: `imports ${file}`,
            });
            nextFrontier.add(edge.source);
          }
        }

        // Semantic refs: symbols defined in this file referenced elsewhere
        const fileOccs = this.store.getOccurrencesByFile(file);
        const defSymbolIds = fileOccs
          .filter((o) => o.roles & 1)
          .map((o) => o.symbol_id);

        for (const symId of defSymbolIds) {
          const refs = this.store.getOccurrencesBySymbol(symId);
          let refCount = 0;
          for (const ref of refs) {
            if (ref.roles & 1) continue; // skip definitions
            refCount++;
            if (!discovered.has(ref.file_path)) {
              const testPenalty = !includeTests && isTestFile(ref.file_path) ? 0.3 : 1.0;
              const refBoost = 1 + 0.3 * Math.min(1, refCount / 5);
              const priority = (1.0 / (1 + d)) * 0.8 * refBoost * testPenalty;
              discovered.set(ref.file_path, {
                priority,
                depth: d,
                reason: `references symbol from ${file}`,
              });
              nextFrontier.add(ref.file_path);
            }
          }
        }
      }

      frontier = nextFrontier;

      // Safety cap: stop BFS if too many discovered
      if (discovered.size >= 100) break;
    }

    // Sort by priority descending
    const sorted = [...discovered.entries()]
      .sort((a, b) => b[1].priority - a[1].priority)
      .slice(0, 100);

    // Greedy token fill
    const snippetCache = createSnippetCache();
    const files: ContextFileEntry[] = [];
    let totalTokens = 0;
    let truncated = false;

    for (const [path, info] of sorted) {
      const fileContent = readFileSafe(this.repoRoot, path);
      const tokenEstimate = fileContent
        ? Math.ceil(fileContent.length / 4)
        : 0;

      // Populate symbols (filter out module-level symbols with no kind)
      const fileSymbols = this.store.getSymbolsByFile(path).filter(
        (sym) => sym.kind !== undefined && sym.kind !== null && sym.kind !== "",
      );
      const symbols = fileSymbols.map((sym) => {
        // A symbol is effectively exported if it has references from other files,
        // or if the file appears in export edges
        let isExported = exportedFiles.has(path);
        if (!isExported) {
          const occs = this.store.getOccurrencesBySymbol(sym.id);
          isExported = occs.some((o) => !(o.roles & 1) && o.file_path !== path);
        }
        return { name: sym.name, kind: sym.kind ?? "unknown", isExported };
      });

      if (totalTokens + tokenEstimate <= budget) {
        // Full content fits
        files.push({
          path,
          priority: info.priority,
          depth: info.depth,
          content: fileContent ?? "",
          symbols,
          reason: info.reason,
          tokenEstimate,
        });
        totalTokens += tokenEstimate;
      } else {
        // Doesn't fit: include signature-only summary
        truncated = true;
        const sigLines: string[] = [];
        for (const sym of fileSymbols) {
          if (sym.range_start != null) {
            const range = formatRange(sym.range_start, sym.range_end ?? sym.range_start);
            const snippet = getSnippet(this.repoRoot, path, range.startLine, snippetCache);
            if (snippet) {
              sigLines.push(snippet.split("\n")[0]);
            }
          }
        }
        const sigContent = sigLines.join("\n");
        const sigTokens = Math.ceil(sigContent.length / 4);

        if (totalTokens + sigTokens <= budget) {
          files.push({
            path,
            priority: info.priority,
            depth: info.depth,
            content: sigContent,
            symbols,
            reason: info.reason + " (signatures only)",
            tokenEstimate: sigTokens,
          });
          totalTokens += sigTokens;
        } else {
          // Can't fit even signatures — stop
          break;
        }
      }
    }

    // Count unique package prefixes
    const pkgs = new Set<string>();
    for (const f of files) {
      const parts = f.path.split("/");
      if (parts.length >= 2) pkgs.add(parts.slice(0, 2).join("/"));
    }

    return {
      files,
      totalTokens,
      truncated,
      entryFiles: entryPaths,
      summary: `${files.length} files, ${pkgs.size} packages, ${totalTokens} tokens`,
    };
  }

  /** Resolve an import target to an actual file path in the index. */
  private _resolveTarget(target: string, allFiles: Set<string>): string | null {
    if (allFiles.has(target)) return target;
    for (const ext of RESOLVE_EXTENSIONS) {
      const withExt = target + ext;
      if (allFiles.has(withExt)) return withExt;
    }
    return null;
  }
}
