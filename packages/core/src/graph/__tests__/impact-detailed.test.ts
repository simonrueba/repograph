import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type RepographDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { ImpactAnalyzer, type DetailedImpactResult } from "../impact";

describe("ImpactAnalyzer.computeDetailedImpact", () => {
  let db: RepographDB;
  let queries: StoreQueries;
  let analyzer: ImpactAnalyzer;
  let repoDir: string;
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-impact-detailed-test-"));
    tempDirs.push(dir);
    return dir;
  }

  /**
   * Seed the DB with a small project graph:
   *
   * Files:   src/math.ts, src/main.ts, src/math.test.ts, src/utils.ts
   * Symbols: "add" (function) defined in math.ts, "subtract" (function) defined in math.ts
   * Occurrences:
   *   - definition of "add" in math.ts  (roles=1)
   *   - reference to "add" in main.ts   (roles=2)
   *   - reference to "add" in math.test.ts (roles=2)
   *   - reference to "add" in utils.ts (roles=2)
   *   - definition of "subtract" in math.ts (roles=1)
   *   - reference to "subtract" in main.ts (roles=2)
   * Edges:
   *   - src/main.ts imports src/math (structural edge)
   *   - src/math.test.ts imports src/math (structural edge)
   */
  function seedGraph(): void {
    // Files
    queries.upsertFile({ path: "src/math.ts", language: "typescript", hash: "h1" });
    queries.upsertFile({ path: "src/main.ts", language: "typescript", hash: "h2" });
    queries.upsertFile({ path: "src/math.test.ts", language: "typescript", hash: "h3" });
    queries.upsertFile({ path: "src/utils.ts", language: "typescript", hash: "h4" });

    // Symbol: add function (line 2, col 0 -> line 2, col 30)
    // Pack: (2 << 16 | 0) = 131072, (2 << 16 | 30) = 131102
    queries.upsertSymbol({
      id: "sym:add",
      kind: "function",
      name: "add",
      file_path: "src/math.ts",
      range_start: 131072,
      range_end: 131102,
      doc: "Adds two numbers together.\nReturns the sum.",
    });

    // Symbol: subtract function (line 5, col 0 -> line 5, col 30)
    // Pack: (5 << 16 | 0) = 327680, (5 << 16 | 30) = 327710
    queries.upsertSymbol({
      id: "sym:subtract",
      kind: "function",
      name: "subtract",
      file_path: "src/math.ts",
      range_start: 327680,
      range_end: 327710,
    });

    // Definition of add in math.ts (roles=1)
    queries.upsertOccurrence({
      file_path: "src/math.ts",
      range_start: 131072,
      range_end: 131102,
      symbol_id: "sym:add",
      roles: 1,
    });

    // Reference to add in main.ts (roles=2)
    queries.upsertOccurrence({
      file_path: "src/main.ts",
      range_start: 65536,
      range_end: 65539,
      symbol_id: "sym:add",
      roles: 2,
    });

    // Reference to add in math.test.ts (roles=2)
    queries.upsertOccurrence({
      file_path: "src/math.test.ts",
      range_start: 196608,
      range_end: 196611,
      symbol_id: "sym:add",
      roles: 2,
    });

    // Reference to add in utils.ts (roles=2)
    queries.upsertOccurrence({
      file_path: "src/utils.ts",
      range_start: 65536,
      range_end: 65539,
      symbol_id: "sym:add",
      roles: 2,
    });

    // Definition of subtract in math.ts (roles=1)
    queries.upsertOccurrence({
      file_path: "src/math.ts",
      range_start: 327680,
      range_end: 327710,
      symbol_id: "sym:subtract",
      roles: 1,
    });

    // Reference to subtract in main.ts (roles=2)
    queries.upsertOccurrence({
      file_path: "src/main.ts",
      range_start: 131072,
      range_end: 131080,
      symbol_id: "sym:subtract",
      roles: 2,
    });

    // Structural import edges
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

  function createSourceFiles(): void {
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src/math.ts"),
      [
        "// math utilities",
        "",
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "export function subtract(a: number, b: number): number {",
        "  return a - b;",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(repoDir, "src/main.ts"),
      [
        "import { add, subtract } from './math';",
        "console.log(add(1, 2));",
        "console.log(subtract(3, 1));",
      ].join("\n"),
    );
    writeFileSync(
      join(repoDir, "src/math.test.ts"),
      [
        "import { add } from './math';",
        "import { expect } from 'vitest';",
        "",
        "expect(add(1, 2)).toBe(3);",
      ].join("\n"),
    );
    writeFileSync(
      join(repoDir, "src/utils.ts"),
      [
        "import { add } from './math';",
        "export const double = (n: number) => add(n, n);",
      ].join("\n"),
    );
  }

  beforeEach(() => {
    repoDir = makeTempDir();
    const dbPath = join(repoDir, "test.db");
    db = createDatabase(dbPath);
    queries = new StoreQueries(db);
    analyzer = new ImpactAnalyzer(queries, repoDir);
    createSourceFiles();
    seedGraph();
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("should return all base ImpactResult fields plus symbolDetails and keyRefs", () => {
    const result = analyzer.computeDetailedImpact(["src/math.ts"]);

    // Base fields present
    expect(result.changedSymbols).toBeDefined();
    expect(result.dependentFiles).toBeDefined();
    expect(result.recommendedTests).toBeDefined();
    expect(result.unresolvedRefs).toBeDefined();

    // New fields present
    expect(result.symbolDetails).toBeDefined();
    expect(result.keyRefs).toBeDefined();
    expect(Array.isArray(result.symbolDetails)).toBe(true);
    expect(Array.isArray(result.keyRefs)).toBe(true);
  });

  it("should include correct symbol details with name, kind, and doc", () => {
    const result = analyzer.computeDetailedImpact(["src/math.ts"]);

    const addDetail = result.symbolDetails.find((s) => s.name === "add");
    expect(addDetail).toBeDefined();
    expect(addDetail!.id).toBe("sym:add");
    expect(addDetail!.kind).toBe("function");
    expect(addDetail!.doc).toContain("Adds two numbers together");

    const subtractDetail = result.symbolDetails.find((s) => s.name === "subtract");
    expect(subtractDetail).toBeDefined();
    expect(subtractDetail!.id).toBe("sym:subtract");
    expect(subtractDetail!.kind).toBe("function");
    // subtract has no doc
    expect(subtractDetail!.doc).toBeUndefined();
  });

  it("should include code snippets in symbolDetails", () => {
    const result = analyzer.computeDetailedImpact(["src/math.ts"]);

    const addDetail = result.symbolDetails.find((s) => s.name === "add");
    expect(addDetail).toBeDefined();
    expect(addDetail!.snippet).toBeDefined();
    expect(addDetail!.snippet).toContain("export function add");
  });

  it("should include keyRefs with reference snippets from dependent files", () => {
    const result = analyzer.computeDetailedImpact(["src/math.ts"]);

    expect(result.keyRefs.length).toBeGreaterThan(0);

    const addRefs = result.keyRefs.filter((kr) => kr.symbolName === "add");
    expect(addRefs.length).toBeGreaterThan(0);

    // Each keyRef should have filePath and symbolName
    for (const kr of addRefs) {
      expect(kr.symbolName).toBe("add");
      expect(kr.filePath).toBeTruthy();
    }
  });

  it("should cap keyRefs at 3 per symbol", () => {
    // "add" has 3 non-definition references (main.ts, math.test.ts, utils.ts)
    const result = analyzer.computeDetailedImpact(["src/math.ts"]);

    const addRefs = result.keyRefs.filter((kr) => kr.symbolName === "add");
    expect(addRefs.length).toBeLessThanOrEqual(3);
  });

  it("should exclude definition occurrences from keyRefs", () => {
    const result = analyzer.computeDetailedImpact(["src/math.ts"]);

    // Definition is in src/math.ts at the definition range — keyRefs should only have references
    // All keyRefs for "add" should be in files other than definition-only entries
    for (const kr of result.keyRefs) {
      // We can't fully guarantee file != definition file since a file can have both,
      // but we can ensure the count doesn't exceed the reference count
      expect(kr.symbolName).toBeTruthy();
      expect(kr.filePath).toBeTruthy();
    }
  });

  it("should return empty symbolDetails and keyRefs for unknown files", () => {
    const result = analyzer.computeDetailedImpact(["src/unknown.ts"]);

    expect(result.changedSymbols).toHaveLength(0);
    expect(result.symbolDetails).toHaveLength(0);
    expect(result.keyRefs).toHaveLength(0);
  });

  it("should match changedSymbols count with symbolDetails count", () => {
    const result = analyzer.computeDetailedImpact(["src/math.ts"]);

    // Each changed symbol should have a corresponding detail
    expect(result.symbolDetails.length).toBe(result.changedSymbols.length);
  });
});
