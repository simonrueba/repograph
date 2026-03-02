import type { StoreQueries, OccurrenceRecord } from "../store/queries";
import { basename, dirname, extname } from "path";
import { getSnippet, formatRange, createSnippetCache, isTestFile } from "./utils";
import { computeRiskScore, type RiskCategory, type RiskBreakdown } from "./risk";

/**
 * Given a source file path (e.g. `src/commands/doctor.ts`), find a co-located
 * test file in the known file set. Checks sibling and `__tests__/` patterns:
 *   foo.ts → foo.test.ts, foo.spec.ts, __tests__/foo.test.ts, __tests__/foo.spec.ts
 */
function findColocatedTestFile(srcPath: string, knownFiles: Set<string>): string | null {
  const ext = extname(srcPath);
  const dir = dirname(srcPath);
  const base = basename(srcPath, ext);

  const candidates = [
    `${dir}/${base}.test${ext}`,
    `${dir}/${base}.spec${ext}`,
    `${dir}/__tests__/${base}.test${ext}`,
    `${dir}/__tests__/${base}.spec${ext}`,
  ];

  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }
  return null;
}

export interface ImpactResult {
  changedSymbols: { id: string; name: string; filePath: string }[];
  dependentFiles: { path: string; reason: string }[];
  recommendedTests: { command: string; reason: string }[];
  unresolvedRefs: { symbolId: string; filePath: string }[];
}

export interface SymbolDetail {
  id: string;
  name: string;
  kind?: string;
  doc?: string;
  snippet?: string;
}

export interface KeyRef {
  symbolName: string;
  filePath: string;
  snippet?: string;
}

export interface DetailedImpactResult extends ImpactResult {
  symbolDetails: SymbolDetail[];
  keyRefs: KeyRef[];
}

export interface TransitiveImpactResult {
  changedSymbols: { id: string; name: string; filePath: string; isPublicApi: boolean }[];
  affectedFiles: { path: string; depth: number; reason: string }[];
  affectedPackages: string[];
  publicApiBreaks: { symbolId: string; symbolName: string; downstream: string[] }[];
  testFiles: { path: string; relevance: "direct" | "transitive" }[];
  testCount: number;
  riskScore: number;
  riskCategory: RiskCategory;
  riskBreakdown: RiskBreakdown;
  boundaryViolationRisk: "none" | "low" | "medium" | "high";
}

function testCommand(path: string): string {
  if (path.endsWith(".py")) return `pytest ${path}`;
  if (path.endsWith("_test.go")) return `go test ./${path.replace(/\/[^/]+$/, "/...")}`;
  if (path.endsWith("_test.rs")) return `cargo test`;
  if (path.endsWith(".java") || path.endsWith(".kt")) return `mvn test -pl ${path.replace(/\/src\/.*/, "")}`;
  if (path.endsWith(".scala")) return `sbt test`;
  if (path.endsWith(".cs")) return `dotnet test`;
  if (path.endsWith("_test.rb") || path.endsWith("_spec.rb")) return `bundle exec ruby ${path}`;
  return `vitest run ${path}`;
}

/** Internal result that carries cached occurrence data for reuse. */
interface ImpactWithOccurrences {
  result: ImpactResult;
  /** Per-symbol occurrence cache: symbol ID → occurrences. */
  occurrenceCache: Map<string, OccurrenceRecord[]>;
}

export class ImpactAnalyzer {
  constructor(
    private store: StoreQueries,
    private repoRoot: string,
  ) {}

  /**
   * Core impact computation that optionally caches occurrence queries
   * so computeDetailedImpact() can reuse them without re-querying.
   */
  private _computeImpactInternal(changedPaths: string[]): ImpactWithOccurrences {
    const changedSymbols: ImpactResult["changedSymbols"] = [];
    const dependentFileSet = new Set<string>();
    const dependentFiles: ImpactResult["dependentFiles"] = [];
    const recommendedTests: ImpactResult["recommendedTests"] = [];
    const testFileSet = new Set<string>();
    const occurrenceCache = new Map<string, OccurrenceRecord[]>();

    // 1. Find symbols defined in changed files (batch lookup to avoid N+1)
    for (const path of changedPaths) {
      const occs = this.store.getOccurrencesByFile(path);
      const defSymbolIds = occs
        .filter((occ) => occ.roles & 1)
        .map((occ) => occ.symbol_id);
      if (defSymbolIds.length === 0) continue;
      const symbolMap = this.store.getSymbolsBatch(defSymbolIds);
      for (const occ of occs) {
        if (occ.roles & 1) {
          const sym = symbolMap.get(occ.symbol_id);
          if (sym) {
            changedSymbols.push({ id: sym.id, name: sym.name, filePath: path });
          }
        }
      }
    }

    // 2. Find files that reference changed symbols (cache results for reuse)
    for (const cs of changedSymbols) {
      const refs = this.store.getOccurrencesBySymbol(cs.id);
      occurrenceCache.set(cs.id, refs);
      for (const ref of refs) {
        if (
          !changedPaths.includes(ref.file_path) &&
          !dependentFileSet.has(ref.file_path)
        ) {
          dependentFileSet.add(ref.file_path);
          dependentFiles.push({
            path: ref.file_path,
            reason: `references ${cs.name}`,
          });
        }
      }
    }

    // 3. Find files that import changed files (structural edges)
    //    Batch-fetch edges for all targets at once (both extensioned + extensionless)
    const targetLookups: string[] = [];
    const targetToPath = new Map<string, string>(); // map target → original changed path
    for (const path of changedPaths) {
      const moduleName = path.replace(/\.[^.]+$/, "");
      targetLookups.push(moduleName);
      targetToPath.set(moduleName, path);
      if (path !== moduleName) {
        targetLookups.push(path);
        targetToPath.set(path, path);
      }
    }
    const allImporterEdges = this.store.getEdgesByTargetBatch(targetLookups);
    const changedPathSet = new Set(changedPaths);
    const seenImporters = new Set<string>();
    for (const edge of allImporterEdges) {
      if (seenImporters.has(edge.source)) continue;
      seenImporters.add(edge.source);
      if (!changedPathSet.has(edge.source) && !dependentFileSet.has(edge.source)) {
        const origPath = targetToPath.get(edge.target) ?? edge.target;
        dependentFileSet.add(edge.source);
        dependentFiles.push({
          path: edge.source,
          reason: `imports ${basename(origPath)}`,
        });
      }
    }

    // 4. Recommend tests from impacted files
    for (const path of [...changedPaths, ...dependentFileSet]) {
      if (isTestFile(path) && !testFileSet.has(path)) {
        testFileSet.add(path);
        recommendedTests.push({
          command: testCommand(path),
          reason: "directly impacted",
        });
      }
    }

    return {
      result: { changedSymbols, dependentFiles, recommendedTests, unresolvedRefs: [] },
      occurrenceCache,
    };
  }

  computeImpact(changedPaths: string[]): ImpactResult {
    return this._computeImpactInternal(changedPaths).result;
  }

  computeDetailedImpact(changedPaths: string[]): DetailedImpactResult {
    const { result: base, occurrenceCache } = this._computeImpactInternal(changedPaths);
    const snippetCache = createSnippetCache();

    // Batch-fetch all symbol details at once (avoids N individual getSymbol calls)
    const symbolIds = base.changedSymbols.map((cs) => cs.id);
    const symbolMap = this.store.getSymbolsBatch(symbolIds);

    const symbolDetails: SymbolDetail[] = [];
    const keyRefs: KeyRef[] = [];

    for (const cs of base.changedSymbols) {
      const sym = symbolMap.get(cs.id);
      if (sym) {
        const range = formatRange(sym.range_start, sym.range_end);
        const snippet = getSnippet(this.repoRoot, cs.filePath, range.startLine, snippetCache);
        symbolDetails.push({
          id: sym.id,
          name: sym.name,
          kind: sym.kind ?? undefined,
          doc: sym.doc ?? undefined,
          snippet,
        });
      }

      // Reuse cached occurrences from _computeImpactInternal (avoids duplicate DB query)
      const refs = occurrenceCache.get(cs.id) ?? this.store.getOccurrencesBySymbol(cs.id);
      let count = 0;
      for (const occ of refs) {
        if (count >= 3) break;
        if (occ.roles & 1) continue; // skip definitions
        const range = formatRange(occ.range_start, occ.range_end);
        const snippet = getSnippet(this.repoRoot, occ.file_path, range.startLine, snippetCache);
        keyRefs.push({
          symbolName: cs.name,
          filePath: occ.file_path,
          snippet,
        });
        count++;
      }
    }

    return { ...base, symbolDetails, keyRefs };
  }

  /**
   * Compute transitive impact using BFS across the symbol graph.
   *
   * Algorithm:
   * 1. Extract changed symbols from changed files
   * 2. BFS loop (depth 1..maxDepth): for each frontier file, find all symbols,
   *    query occurrences to discover new affected files, query structural importers.
   *    Optionally traverse call graph edges (callers of changed symbols).
   * 3. Detect public API symbols via export edges
   * 4. Map files to packages via projects table (longest prefix match)
   * 5. Identify public API breaks: changed public symbols with downstream package refs
   * 6. Correlate test files: "direct" (depth ≤ 1) or "transitive"
   * 7. Compute risk score
   */
  computeTransitiveImpact(
    changedPaths: string[],
    opts?: { maxDepth?: number; includeCallGraph?: boolean },
  ): TransitiveImpactResult {
    const maxDepth = opts?.maxDepth ?? 5;
    const includeCallGraph = opts?.includeCallGraph ?? false;

    // 1. Extract changed symbols from changed files
    const changedSymbols: TransitiveImpactResult["changedSymbols"] = [];
    const changedSymbolIds = new Set<string>();

    for (const path of changedPaths) {
      const occs = this.store.getOccurrencesByFile(path);
      const defIds = occs.filter((o) => o.roles & 1).map((o) => o.symbol_id);
      if (defIds.length === 0) continue;
      const symbolMap = this.store.getSymbolsBatch(defIds);
      for (const occ of occs) {
        if (!(occ.roles & 1)) continue;
        const sym = symbolMap.get(occ.symbol_id);
        if (sym && !changedSymbolIds.has(sym.id)) {
          changedSymbolIds.add(sym.id);
          changedSymbols.push({
            id: sym.id,
            name: sym.name,
            filePath: path,
            isPublicApi: false, // filled in later
          });
        }
      }
    }

    // 2. BFS transitive closure
    const visitedFiles = new Set<string>(changedPaths);
    const affectedFiles: TransitiveImpactResult["affectedFiles"] = [];
    let frontier = new Set<string>(changedPaths);

    for (let depth = 1; depth <= maxDepth && frontier.size > 0; depth++) {
      const nextFrontier = new Set<string>();

      for (const file of frontier) {
        // Find symbols defined in this file
        const occs = this.store.getOccurrencesByFile(file);
        const defSymbolIds = occs
          .filter((o) => o.roles & 1)
          .map((o) => o.symbol_id);

        // Find files that reference those symbols
        for (const symId of defSymbolIds) {
          const refs = this.store.getOccurrencesBySymbol(symId);
          for (const ref of refs) {
            if (!visitedFiles.has(ref.file_path)) {
              visitedFiles.add(ref.file_path);
              nextFrontier.add(ref.file_path);
              affectedFiles.push({
                path: ref.file_path,
                depth,
                reason: `references symbol from ${basename(file)}`,
              });
            }
          }
        }

        // Find files that structurally import this file
        const moduleName = file.replace(/\.[^.]+$/, "");
        const importerEdges = this.store.getEdgesByTargetBatch([moduleName, file]);
        for (const edge of importerEdges) {
          if (!visitedFiles.has(edge.source)) {
            visitedFiles.add(edge.source);
            nextFrontier.add(edge.source);
            affectedFiles.push({
              path: edge.source,
              depth,
              reason: `imports ${basename(file)}`,
            });
          }
        }

        // Optionally traverse call graph (callers of symbols in this file)
        if (includeCallGraph) {
          for (const symId of defSymbolIds) {
            const callers = this.store.getCallers(symId);
            for (const caller of callers) {
              // caller.source is a symbol ID — resolve to file
              const callerSym = this.store.getSymbol(caller.source);
              if (callerSym?.file_path && !visitedFiles.has(callerSym.file_path)) {
                visitedFiles.add(callerSym.file_path);
                nextFrontier.add(callerSym.file_path);
                affectedFiles.push({
                  path: callerSym.file_path,
                  depth,
                  reason: `calls symbol in ${basename(file)}`,
                });
              }
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    // 3. Detect public API symbols via export edges
    const exportEdges = this.store.getExportEdges();
    const exportedFiles = new Set<string>();
    for (const edge of exportEdges) {
      exportedFiles.add(edge.source);
    }
    for (const cs of changedSymbols) {
      if (exportedFiles.has(cs.filePath)) {
        cs.isPublicApi = true;
      }
    }

    // 4. Map files to packages via projects table (longest prefix match)
    const projects = this.store.getAllProjects();
    const sortedProjects = [...projects].sort(
      (a, b) => b.root.length - a.root.length,
    );

    function getPackage(filePath: string): string | null {
      for (const p of sortedProjects) {
        if (filePath.startsWith(p.root + "/") || filePath === p.root) {
          return p.project_id;
        }
      }
      return null;
    }

    const affectedPackageSet = new Set<string>();
    for (const file of visitedFiles) {
      const pkg = getPackage(file);
      if (pkg) affectedPackageSet.add(pkg);
    }

    // 5. Identify public API breaks
    const publicApiBreaks: TransitiveImpactResult["publicApiBreaks"] = [];
    const publicSymbols = changedSymbols.filter((s) => s.isPublicApi);
    const changedPackages = new Set(
      changedPaths.map((p) => getPackage(p)).filter(Boolean) as string[],
    );

    for (const ps of publicSymbols) {
      const refs = this.store.getOccurrencesBySymbol(ps.id);
      const downstreamPkgs = new Set<string>();
      for (const ref of refs) {
        if (ref.roles & 1) continue; // skip definitions
        const pkg = getPackage(ref.file_path);
        if (pkg && !changedPackages.has(pkg)) {
          downstreamPkgs.add(pkg);
        }
      }
      if (downstreamPkgs.size > 0) {
        publicApiBreaks.push({
          symbolId: ps.id,
          symbolName: ps.name,
          downstream: [...downstreamPkgs],
        });
      }
    }

    // 6. Correlate test files
    const testFiles: TransitiveImpactResult["testFiles"] = [];
    for (const af of affectedFiles) {
      if (isTestFile(af.path)) {
        testFiles.push({
          path: af.path,
          relevance: af.depth <= 1 ? "direct" : "transitive",
        });
      }
    }
    // Also check changed files themselves
    for (const cp of changedPaths) {
      if (isTestFile(cp)) {
        testFiles.push({ path: cp, relevance: "direct" });
      }
    }

    // 6b. Detect co-located test files (e2e tests that run via subprocess,
    //     not via import edges). For each affected source file, check if a
    //     matching test file exists in the index (e.g. foo.ts → foo.test.ts
    //     or __tests__/foo.test.ts). Track which source files are covered.
    const testedPathSet = new Set(testFiles.map((t) => t.path));
    const coveredSourcePaths = new Set<string>();
    const allKnownFiles = this.store.getFilePaths();
    for (const af of affectedFiles) {
      if (isTestFile(af.path)) continue;
      const colocated = findColocatedTestFile(af.path, allKnownFiles);
      if (colocated && !testedPathSet.has(colocated)) {
        testedPathSet.add(colocated);
        testFiles.push({ path: colocated, relevance: "direct" });
        coveredSourcePaths.add(af.path);
      }
    }

    // 7. Compute risk score
    const totalFiles = this.store.getFileCount();
    const testedPaths = new Set(testFiles.map((t) => t.path));
    const untestedCount = affectedFiles.filter(
      (f) => !testedPaths.has(f.path) && !isTestFile(f.path) && !coveredSourcePaths.has(f.path),
    ).length;

    const boundaryProximity = publicSymbols.length > 0
      ? Math.min(publicApiBreaks.length / Math.max(publicSymbols.length, 1), 1)
      : 0;

    const risk = computeRiskScore({
      affectedFileCount: affectedFiles.length,
      totalFileCount: totalFiles,
      publicApiBreakCount: publicApiBreaks.length,
      affectedPackageCount: affectedPackageSet.size,
      totalPackageCount: Math.max(projects.length, 1),
      untestedAffectedFileCount: untestedCount,
      totalAffectedFileCount: affectedFiles.length,
      boundaryProximity,
    });

    let boundaryViolationRisk: TransitiveImpactResult["boundaryViolationRisk"] = "none";
    if (publicApiBreaks.length > 0) {
      if (publicApiBreaks.length >= 5) boundaryViolationRisk = "high";
      else if (publicApiBreaks.length >= 2) boundaryViolationRisk = "medium";
      else boundaryViolationRisk = "low";
    }

    return {
      changedSymbols,
      affectedFiles,
      affectedPackages: [...affectedPackageSet],
      publicApiBreaks,
      testFiles,
      testCount: testFiles.length,
      riskScore: risk.score,
      riskCategory: risk.category,
      riskBreakdown: risk.breakdown,
      boundaryViolationRisk,
    };
  }
}
