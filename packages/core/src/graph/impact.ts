import type { StoreQueries } from "../store/queries";
import { basename } from "path";

export interface ImpactResult {
  changedSymbols: { id: string; name: string; filePath: string }[];
  dependentFiles: { path: string; reason: string }[];
  recommendedTests: { command: string; reason: string }[];
  unresolvedRefs: { symbolId: string; filePath: string }[];
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

export class ImpactAnalyzer {
  constructor(
    private store: StoreQueries,
    private repoRoot: string,
  ) {}

  computeImpact(changedPaths: string[]): ImpactResult {
    const changedSymbols: ImpactResult["changedSymbols"] = [];
    const dependentFileSet = new Set<string>();
    const dependentFiles: ImpactResult["dependentFiles"] = [];
    const recommendedTests: ImpactResult["recommendedTests"] = [];
    const testFileSet = new Set<string>();

    // 1. Find symbols defined in changed files
    for (const path of changedPaths) {
      const occs = this.store.getOccurrencesByFile(path);
      for (const occ of occs) {
        if (occ.roles & 1) {
          // Definition role
          const sym = this.store.getSymbol(occ.symbol_id);
          if (sym) {
            changedSymbols.push({ id: sym.id, name: sym.name, filePath: path });
          }
        }
      }
    }

    // 2. Find files that reference changed symbols
    for (const cs of changedSymbols) {
      const refs = this.store.getOccurrencesBySymbol(cs.id);
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
    for (const path of changedPaths) {
      // Try both the exact path (resolved with extension) and the
      // extensionless form (legacy edges created before knownFiles resolution).
      const moduleName = path.replace(/\.[^.]+$/, "");
      const importersByModule = this.store.getEdgesByTarget(moduleName);
      const importersByPath = path !== moduleName ? this.store.getEdgesByTarget(path) : [];
      const seen = new Set<string>();
      const importers = [...importersByModule, ...importersByPath].filter((e) => {
        if (seen.has(e.source)) return false;
        seen.add(e.source);
        return true;
      });
      for (const edge of importers) {
        if (
          !changedPaths.includes(edge.source) &&
          !dependentFileSet.has(edge.source)
        ) {
          dependentFileSet.add(edge.source);
          dependentFiles.push({
            path: edge.source,
            reason: `imports ${basename(path)}`,
          });
        }
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

    return { changedSymbols, dependentFiles, recommendedTests, unresolvedRefs: [] };
  }
}
