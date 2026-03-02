import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type AriadneDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { ImpactAnalyzer } from "../impact";

describe("computeTransitiveImpact", () => {
  let db: AriadneDB;
  let store: StoreQueries;
  let analyzer: ImpactAnalyzer;
  const tempDirs: string[] = [];

  function makeTempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-transitive-test-"));
    tempDirs.push(dir);
    return join(dir, "test.db");
  }

  /**
   * Seed a multi-depth graph:
   *
   *   src/core.ts  (defines "compute", public API)
   *     └─ referenced by src/service.ts (depth 1)
   *         └─ referenced by src/handler.ts (depth 2)
   *             └─ referenced by src/handler.test.ts (depth 3, test file)
   *   src/util.ts  (defines "format")
   *     └─ referenced by src/service.ts (depth 1, also imports core)
   *
   *   Packages:
   *     pkg-core  → root "packages/core"
   *     pkg-app   → root "packages/app"
   *
   *   Cross-package reference: packages/app/api.ts references "compute"
   */
  function seedTransitiveGraph(): void {
    // Files
    store.upsertFile({ path: "src/core.ts", language: "typescript", hash: "h1" });
    store.upsertFile({ path: "src/service.ts", language: "typescript", hash: "h2" });
    store.upsertFile({ path: "src/handler.ts", language: "typescript", hash: "h3" });
    store.upsertFile({ path: "src/handler.test.ts", language: "typescript", hash: "h4" });
    store.upsertFile({ path: "src/util.ts", language: "typescript", hash: "h5" });
    store.upsertFile({ path: "packages/app/api.ts", language: "typescript", hash: "h6" });
    store.upsertFile({ path: "packages/core/index.ts", language: "typescript", hash: "h7" });

    // Symbols
    store.upsertSymbol({ id: "sym:compute", kind: "function", name: "compute", file_path: "src/core.ts", range_start: 0, range_end: 50 });
    store.upsertSymbol({ id: "sym:format", kind: "function", name: "format", file_path: "src/util.ts", range_start: 0, range_end: 30 });
    store.upsertSymbol({ id: "sym:handle", kind: "function", name: "handle", file_path: "src/handler.ts", range_start: 0, range_end: 40 });
    store.upsertSymbol({ id: "sym:process", kind: "function", name: "process", file_path: "src/service.ts", range_start: 0, range_end: 60 });

    // Occurrences — definitions
    store.upsertOccurrence({ file_path: "src/core.ts", range_start: 0, range_end: 50, symbol_id: "sym:compute", roles: 1 });
    store.upsertOccurrence({ file_path: "src/util.ts", range_start: 0, range_end: 30, symbol_id: "sym:format", roles: 1 });
    store.upsertOccurrence({ file_path: "src/handler.ts", range_start: 0, range_end: 40, symbol_id: "sym:handle", roles: 1 });
    store.upsertOccurrence({ file_path: "src/service.ts", range_start: 0, range_end: 60, symbol_id: "sym:process", roles: 1 });

    // Occurrences — references (build depth chain)
    // depth 1: service references compute
    store.upsertOccurrence({ file_path: "src/service.ts", range_start: 10, range_end: 20, symbol_id: "sym:compute", roles: 2 });
    // depth 1: service references format
    store.upsertOccurrence({ file_path: "src/service.ts", range_start: 30, range_end: 40, symbol_id: "sym:format", roles: 2 });
    // depth 2: handler references process (defined in service)
    store.upsertOccurrence({ file_path: "src/handler.ts", range_start: 10, range_end: 20, symbol_id: "sym:process", roles: 2 });
    // depth 3: handler.test references handle
    store.upsertOccurrence({ file_path: "src/handler.test.ts", range_start: 5, range_end: 15, symbol_id: "sym:handle", roles: 2 });

    // Cross-package reference: app/api.ts references compute
    store.upsertOccurrence({ file_path: "packages/app/api.ts", range_start: 5, range_end: 15, symbol_id: "sym:compute", roles: 2 });

    // Import edges
    store.insertEdge({ source: "src/service.ts", target: "src/core", kind: "imports" });
    store.insertEdge({ source: "src/service.ts", target: "src/util", kind: "imports" });
    store.insertEdge({ source: "src/handler.ts", target: "src/service", kind: "imports" });
    store.insertEdge({ source: "src/handler.test.ts", target: "src/handler", kind: "imports" });

    // Export edge (makes core.ts a public API file)
    store.insertEdge({ source: "src/core.ts", target: "sym:compute", kind: "exports" });

    // Projects
    store.upsertProject({ project_id: "pkg-core", root: "src", language: "typescript", last_index_ts: Date.now() });
    store.upsertProject({ project_id: "pkg-app", root: "packages/app", language: "typescript", last_index_ts: Date.now() });
  }

  beforeEach(() => {
    db = createDatabase(makeTempDb());
    store = new StoreQueries(db);
    analyzer = new ImpactAnalyzer(store, "/repo");
    seedTransitiveGraph();
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("should find changed symbols with public API flag", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    expect(result.changedSymbols).toHaveLength(1);
    expect(result.changedSymbols[0].name).toBe("compute");
    expect(result.changedSymbols[0].isPublicApi).toBe(true);
  });

  it("should traverse multiple BFS depths", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    const paths = result.affectedFiles.map((f) => f.path);
    // depth 1: service references compute
    expect(paths).toContain("src/service.ts");
    // depth 2: handler references process (defined in service)
    expect(paths).toContain("src/handler.ts");
    // depth 3: handler.test references handle (defined in handler)
    expect(paths).toContain("src/handler.test.ts");
  });

  it("should respect maxDepth cap", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"], { maxDepth: 1 });

    const paths = result.affectedFiles.map((f) => f.path);
    // depth 1: service references compute, and packages/app/api.ts references compute
    expect(paths).toContain("src/service.ts");
    // depth 2+ should NOT be reached
    expect(paths).not.toContain("src/handler.ts");
    expect(paths).not.toContain("src/handler.test.ts");
  });

  it("should track depth for each affected file", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    const serviceFile = result.affectedFiles.find((f) => f.path === "src/service.ts");
    expect(serviceFile).toBeDefined();
    expect(serviceFile!.depth).toBe(1);

    const handlerFile = result.affectedFiles.find((f) => f.path === "src/handler.ts");
    expect(handlerFile).toBeDefined();
    expect(handlerFile!.depth).toBe(2);
  });

  it("should not revisit files (deduplication)", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    const allPaths = result.affectedFiles.map((f) => f.path);
    const uniquePaths = new Set(allPaths);
    expect(allPaths.length).toBe(uniquePaths.size);
  });

  it("should not include changed files in affected files", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    const paths = result.affectedFiles.map((f) => f.path);
    expect(paths).not.toContain("src/core.ts");
  });

  it("should detect public API breaks with downstream packages", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    // compute is public, referenced by packages/app/api.ts (different package)
    expect(result.publicApiBreaks.length).toBeGreaterThan(0);
    const computeBreak = result.publicApiBreaks.find((b) => b.symbolName === "compute");
    expect(computeBreak).toBeDefined();
    expect(computeBreak!.downstream).toContain("pkg-app");
  });

  it("should identify affected packages", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    expect(result.affectedPackages).toContain("pkg-core");
    expect(result.affectedPackages).toContain("pkg-app");
  });

  it("should correlate test files with relevance", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    expect(result.testFiles.length).toBeGreaterThan(0);
    const handlerTest = result.testFiles.find((t) => t.path === "src/handler.test.ts");
    expect(handlerTest).toBeDefined();
    expect(handlerTest!.relevance).toBe("transitive");
  });

  it("should produce a risk score and category", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(1);
    expect(["low", "medium", "high", "critical"]).toContain(result.riskCategory);
  });

  it("should set boundaryViolationRisk based on public API breaks", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    // We have at least 1 public API break
    expect(result.boundaryViolationRisk).not.toBe("none");
  });

  it("should return empty results for unknown files", () => {
    const result = analyzer.computeTransitiveImpact(["nonexistent.ts"]);

    expect(result.changedSymbols).toHaveLength(0);
    expect(result.affectedFiles).toHaveLength(0);
    expect(result.publicApiBreaks).toHaveLength(0);
    expect(result.riskScore).toBe(0);
    expect(result.riskCategory).toBe("low");
  });

  it("should handle call graph traversal when enabled", () => {
    // Add a call edge: handle calls process
    store.insertEdge({ source: "sym:handle", target: "sym:process", kind: "calls" });

    const result = analyzer.computeTransitiveImpact(["src/service.ts"], { includeCallGraph: true });

    // handler.ts should be found through call graph (handle calls process)
    const paths = result.affectedFiles.map((f) => f.path);
    expect(paths).toContain("src/handler.ts");
  });

  it("should work with multiple changed paths", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts", "src/util.ts"]);

    expect(result.changedSymbols.length).toBeGreaterThanOrEqual(2);
    const names = result.changedSymbols.map((s) => s.name);
    expect(names).toContain("compute");
    expect(names).toContain("format");
  });

  it("should count test files correctly", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    expect(result.testCount).toBe(result.testFiles.length);
  });

  it("should include riskBreakdown in result", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    expect(result.riskBreakdown).toBeDefined();
    expect(typeof result.riskBreakdown.fileSpread).toBe("number");
    expect(typeof result.riskBreakdown.publicApiBreak).toBe("number");
    expect(typeof result.riskBreakdown.packageSpread).toBe("number");
    expect(typeof result.riskBreakdown.testGap).toBe("number");
    expect(typeof result.riskBreakdown.boundary).toBe("number");
  });

  it("should have riskBreakdown values between 0 and 1", () => {
    const result = analyzer.computeTransitiveImpact(["src/core.ts"]);

    for (const value of Object.values(result.riskBreakdown)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
