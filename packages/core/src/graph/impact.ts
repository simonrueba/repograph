import type { StoreQueries, OccurrenceRecord } from "../store/queries";
import { basename } from "path";
import { getSnippet, formatRange, createSnippetCache } from "./utils";

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

const TEST_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /test_.*\.py$/,
  /.*_test\.py$/,
];

function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(path));
}

function testCommand(path: string): string {
  return path.endsWith(".py") ? `pytest ${path}` : `vitest run ${path}`;
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
}
