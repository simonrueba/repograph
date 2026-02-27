import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type RepographDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { ImpactAnalyzer, type ImpactResult } from "../impact";

describe("ImpactAnalyzer", () => {
  let db: RepographDB;
  let queries: StoreQueries;
  let analyzer: ImpactAnalyzer;
  const tempDirs: string[] = [];

  function makeTempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-impact-test-"));
    tempDirs.push(dir);
    return join(dir, "test.db");
  }

  /**
   * Seed the DB with a small project graph:
   *
   * Files:   src/math.ts, src/main.ts, src/math.test.ts
   * Symbols: "add" (function) defined in math.ts
   * Occurrences:
   *   - definition of "add" in math.ts  (roles=1)
   *   - reference to "add" in main.ts   (roles=2)
   *   - reference to "add" in math.test.ts (roles=2)
   * Edges:
   *   - src/main.ts imports src/math (structural edge)
   *   - src/math.test.ts imports src/math (structural edge)
   */
  function seedGraph(): void {
    // Files
    queries.upsertFile({ path: "src/math.ts", language: "typescript", hash: "h1" });
    queries.upsertFile({ path: "src/main.ts", language: "typescript", hash: "h2" });
    queries.upsertFile({ path: "src/math.test.ts", language: "typescript", hash: "h3" });

    // Symbol: add function
    queries.upsertSymbol({
      id: "sym:add",
      kind: "function",
      name: "add",
      file_path: "src/math.ts",
      range_start: 0,
      range_end: 50,
    });

    // Occurrences
    // Definition of add in math.ts (roles=1 means definition)
    queries.upsertOccurrence({
      file_path: "src/math.ts",
      range_start: 0,
      range_end: 50,
      symbol_id: "sym:add",
      roles: 1,
    });

    // Reference to add in main.ts (roles=2 means reference)
    queries.upsertOccurrence({
      file_path: "src/main.ts",
      range_start: 10,
      range_end: 20,
      symbol_id: "sym:add",
      roles: 2,
    });

    // Reference to add in math.test.ts (roles=2 means reference)
    queries.upsertOccurrence({
      file_path: "src/math.test.ts",
      range_start: 5,
      range_end: 15,
      symbol_id: "sym:add",
      roles: 2,
    });

    // Structural import edges: source imports target module
    queries.insertEdge({
      source: "src/main.ts",
      target: "src/math",
      kind: "imports",
    });
    queries.insertEdge({
      source: "src/math.test.ts",
      target: "src/math",
      kind: "imports",
    });
  }

  beforeEach(() => {
    db = createDatabase(makeTempDb());
    queries = new StoreQueries(db);
    analyzer = new ImpactAnalyzer(queries, "/repo");
    seedGraph();
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("should find changed symbols defined in changed files", () => {
    const result = analyzer.computeImpact(["src/math.ts"]);

    expect(result.changedSymbols).toHaveLength(1);
    expect(result.changedSymbols[0].name).toBe("add");
    expect(result.changedSymbols[0].id).toBe("sym:add");
    expect(result.changedSymbols[0].filePath).toBe("src/math.ts");
  });

  it("should find dependent files that reference changed symbols", () => {
    const result = analyzer.computeImpact(["src/math.ts"]);

    const dependentPaths = result.dependentFiles.map((f) => f.path);
    expect(dependentPaths).toContain("src/main.ts");
    expect(dependentPaths).toContain("src/math.test.ts");
  });

  it("should not include changed files themselves as dependents", () => {
    const result = analyzer.computeImpact(["src/math.ts"]);

    const dependentPaths = result.dependentFiles.map((f) => f.path);
    expect(dependentPaths).not.toContain("src/math.ts");
  });

  it("should include reason for dependency", () => {
    const result = analyzer.computeImpact(["src/math.ts"]);

    const mainDep = result.dependentFiles.find((f) => f.path === "src/main.ts");
    expect(mainDep).toBeDefined();
    expect(mainDep!.reason).toContain("add");
  });

  it("should recommend tests from impacted test files", () => {
    const result = analyzer.computeImpact(["src/math.ts"]);

    expect(result.recommendedTests.length).toBeGreaterThan(0);
    const testCommands = result.recommendedTests.map((t) => t.command);
    expect(testCommands).toContain("vitest run src/math.test.ts");
  });

  it("should recommend tests with vitest for .test.ts files", () => {
    const result = analyzer.computeImpact(["src/math.ts"]);

    const mathTest = result.recommendedTests.find((t) =>
      t.command.includes("math.test.ts"),
    );
    expect(mathTest).toBeDefined();
    expect(mathTest!.command).toMatch(/^vitest run/);
  });

  it("should recommend pytest for Python test files", () => {
    // Add a Python test file
    queries.upsertFile({
      path: "tests/test_utils.py",
      language: "python",
      hash: "h4",
    });
    queries.upsertOccurrence({
      file_path: "tests/test_utils.py",
      range_start: 0,
      range_end: 10,
      symbol_id: "sym:add",
      roles: 2,
    });

    const result = analyzer.computeImpact(["src/math.ts"]);

    const pyTest = result.recommendedTests.find((t) =>
      t.command.includes("test_utils.py"),
    );
    expect(pyTest).toBeDefined();
    expect(pyTest!.command).toMatch(/^pytest/);
  });

  it("should return empty results for files with no symbols", () => {
    const result = analyzer.computeImpact(["src/unknown.ts"]);

    expect(result.changedSymbols).toHaveLength(0);
    expect(result.dependentFiles).toHaveLength(0);
    expect(result.recommendedTests).toHaveLength(0);
  });

  it("should find importers via structural edges", () => {
    // Clear occurrences to isolate edge-based detection
    queries.clearAllOccurrences();

    const result = analyzer.computeImpact(["src/math.ts"]);

    const dependentPaths = result.dependentFiles.map((f) => f.path);
    expect(dependentPaths).toContain("src/main.ts");
    expect(dependentPaths).toContain("src/math.test.ts");
  });

  it("should not duplicate dependent files found via both symbols and edges", () => {
    const result = analyzer.computeImpact(["src/math.ts"]);

    const mainCount = result.dependentFiles.filter(
      (f) => f.path === "src/main.ts",
    ).length;
    expect(mainCount).toBe(1);
  });

  it("should return empty unresolvedRefs (placeholder)", () => {
    const result = analyzer.computeImpact(["src/math.ts"]);
    expect(result.unresolvedRefs).toEqual([]);
  });
});
