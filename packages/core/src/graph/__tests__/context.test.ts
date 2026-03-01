import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type AriadneDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { ContextCompiler, type ContextResult } from "../context";

describe("ContextCompiler", () => {
  let db: AriadneDB;
  let queries: StoreQueries;
  let compiler: ContextCompiler;
  let repoDir: string;
  const tempDirs: string[] = [];

  function makeTempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-context-test-"));
    tempDirs.push(dir);
    return dir;
  }

  /**
   * Seed graph:
   *
   * entry.ts → imports utils.ts, config.ts
   * utils.ts → imports types.ts
   * consumer.ts → imports entry.ts (reverse direction)
   * entry.test.ts → imports entry.ts (test file)
   *
   * Symbols:
   *   entry.ts defines "main" (exported), "helper" (private)
   *   utils.ts defines "formatDate" (exported)
   *   config.ts defines "getConfig" (exported)
   *   types.ts defines "MyType" (exported)
   */
  function seedGraph(): void {
    // Files
    for (const f of [
      "src/entry.ts",
      "src/utils.ts",
      "src/config.ts",
      "src/types.ts",
      "src/consumer.ts",
      "src/entry.test.ts",
    ]) {
      queries.upsertFile({ path: f, language: "typescript", hash: "h" });
    }

    // Write actual files on disk for content reading
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src/entry.ts"), "export function main() {\n  return helper();\n}\nfunction helper() { return 1; }\n");
    writeFileSync(join(repoDir, "src/utils.ts"), "export function formatDate(d: Date) {\n  return d.toISOString();\n}\n");
    writeFileSync(join(repoDir, "src/config.ts"), "export function getConfig() {\n  return {};\n}\n");
    writeFileSync(join(repoDir, "src/types.ts"), "export type MyType = { id: string };\n");
    writeFileSync(join(repoDir, "src/consumer.ts"), "import { main } from './entry';\nmain();\n");
    writeFileSync(join(repoDir, "src/entry.test.ts"), "import { main } from './entry';\ntest('main', () => main());\n");

    // Symbols
    queries.upsertSymbol({ id: "sym:main", kind: "function", name: "main", file_path: "src/entry.ts", range_start: 0, range_end: 50 });
    queries.upsertSymbol({ id: "sym:helper", kind: "function", name: "helper", file_path: "src/entry.ts", range_start: (3 << 16), range_end: (3 << 16) + 30 });
    queries.upsertSymbol({ id: "sym:formatDate", kind: "function", name: "formatDate", file_path: "src/utils.ts", range_start: 0, range_end: 40 });
    queries.upsertSymbol({ id: "sym:getConfig", kind: "function", name: "getConfig", file_path: "src/config.ts", range_start: 0, range_end: 30 });
    queries.upsertSymbol({ id: "sym:MyType", kind: "type", name: "MyType", file_path: "src/types.ts", range_start: 0, range_end: 30 });

    // Occurrences - definitions (roles=1)
    queries.upsertOccurrence({ file_path: "src/entry.ts", range_start: 0, range_end: 50, symbol_id: "sym:main", roles: 1 });
    queries.upsertOccurrence({ file_path: "src/entry.ts", range_start: (3 << 16), range_end: (3 << 16) + 30, symbol_id: "sym:helper", roles: 1 });
    queries.upsertOccurrence({ file_path: "src/utils.ts", range_start: 0, range_end: 40, symbol_id: "sym:formatDate", roles: 1 });
    queries.upsertOccurrence({ file_path: "src/config.ts", range_start: 0, range_end: 30, symbol_id: "sym:getConfig", roles: 1 });
    queries.upsertOccurrence({ file_path: "src/types.ts", range_start: 0, range_end: 30, symbol_id: "sym:MyType", roles: 1 });

    // Occurrences - references (roles=2)
    queries.upsertOccurrence({ file_path: "src/consumer.ts", range_start: 10, range_end: 20, symbol_id: "sym:main", roles: 2 });
    queries.upsertOccurrence({ file_path: "src/entry.test.ts", range_start: 10, range_end: 20, symbol_id: "sym:main", roles: 2 });

    // Import edges (structural)
    queries.insertEdge({ source: "src/entry.ts", target: "src/utils", kind: "imports" });
    queries.insertEdge({ source: "src/entry.ts", target: "src/config", kind: "imports" });
    queries.insertEdge({ source: "src/utils.ts", target: "src/types", kind: "imports" });
    queries.insertEdge({ source: "src/consumer.ts", target: "src/entry", kind: "imports" });
    queries.insertEdge({ source: "src/entry.test.ts", target: "src/entry", kind: "imports" });

    // Export edges (entry.ts is exported by a package)
    queries.insertEdge({ source: "src/entry.ts", target: "pkg", kind: "exports" });
    queries.insertEdge({ source: "src/utils.ts", target: "pkg", kind: "exports" });
    queries.insertEdge({ source: "src/config.ts", target: "pkg", kind: "exports" });
    queries.insertEdge({ source: "src/types.ts", target: "pkg", kind: "exports" });
  }

  beforeEach(() => {
    repoDir = makeTempRepo();
    db = createDatabase(join(repoDir, "test.db"));
    queries = new StoreQueries(db);
    compiler = new ContextCompiler(queries, repoDir);
    seedGraph();
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("should include entry files at highest priority", () => {
    const result = compiler.compile(["src/entry.ts"]);

    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files[0].path).toBe("src/entry.ts");
    expect(result.files[0].priority).toBe(1.0);
    expect(result.files[0].depth).toBe(0);
    expect(result.files[0].reason).toBe("entry file");
  });

  it("should include imported files at depth 1", () => {
    const result = compiler.compile(["src/entry.ts"]);

    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/utils.ts");
    expect(paths).toContain("src/config.ts");

    const utils = result.files.find((f) => f.path === "src/utils.ts")!;
    expect(utils.depth).toBe(1);
  });

  it("should include reverse importers at depth 1", () => {
    const result = compiler.compile(["src/entry.ts"]);

    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/consumer.ts");

    const consumer = result.files.find((f) => f.path === "src/consumer.ts")!;
    expect(consumer.depth).toBe(1);
  });

  it("should respect depth limit", () => {
    const result = compiler.compile(["src/entry.ts"], { depth: 1 });

    const paths = result.files.map((f) => f.path);
    // types.ts is at depth 2 (entry → utils → types), should not appear at depth 1
    expect(paths).not.toContain("src/types.ts");
  });

  it("should include transitive imports within depth", () => {
    const result = compiler.compile(["src/entry.ts"], { depth: 2 });

    const paths = result.files.map((f) => f.path);
    // types.ts is at depth 2 (entry → utils → types)
    expect(paths).toContain("src/types.ts");
  });

  it("should penalize test files when includeTests is false", () => {
    const result = compiler.compile(["src/entry.ts"], { includeTests: false });

    const testEntry = result.files.find((f) => f.path === "src/entry.test.ts");
    if (testEntry) {
      // Test file should have low priority (penalized by 0.3)
      expect(testEntry.priority).toBeLessThan(0.3);
    }
  });

  it("should not penalize test files when includeTests is true", () => {
    const result = compiler.compile(["src/entry.ts"], { includeTests: true });

    const testEntry = result.files.find((f) => f.path === "src/entry.test.ts");
    expect(testEntry).toBeDefined();
    // Without penalty, reverse importer at depth 1: 1/(1+1) * 0.6 = 0.3
    expect(testEntry!.priority).toBeGreaterThanOrEqual(0.15);
  });

  it("should sort files by priority descending", () => {
    const result = compiler.compile(["src/entry.ts"]);

    for (let i = 1; i < result.files.length; i++) {
      expect(result.files[i - 1].priority).toBeGreaterThanOrEqual(
        result.files[i].priority,
      );
    }
  });

  it("should truncate when hitting token budget", () => {
    // Very small budget
    const result = compiler.compile(["src/entry.ts"], { budget: 50 });

    expect(result.truncated).toBe(true);
    expect(result.totalTokens).toBeLessThanOrEqual(50);
  });

  it("should include full content when within budget", () => {
    const result = compiler.compile(["src/entry.ts"], { budget: 100000 });

    const entryFile = result.files.find((f) => f.path === "src/entry.ts")!;
    expect(entryFile.content).toContain("export function main()");
  });

  it("should populate symbols for each file", () => {
    const result = compiler.compile(["src/entry.ts"]);

    const entryFile = result.files.find((f) => f.path === "src/entry.ts")!;
    expect(entryFile.symbols.length).toBeGreaterThan(0);
    const mainSym = entryFile.symbols.find((s) => s.name === "main");
    expect(mainSym).toBeDefined();
    expect(mainSym!.kind).toBe("function");
  });

  it("should detect exported symbols", () => {
    const result = compiler.compile(["src/entry.ts"]);

    const entryFile = result.files.find((f) => f.path === "src/entry.ts")!;
    // entry.ts has export edges, so symbols should be marked exported
    expect(entryFile.symbols.some((s) => s.isExported)).toBe(true);
  });

  it("should include summary string", () => {
    const result = compiler.compile(["src/entry.ts"]);

    expect(result.summary).toMatch(/\d+ files/);
    expect(result.summary).toMatch(/\d+ tokens/);
  });

  it("should report entryFiles in result", () => {
    const result = compiler.compile(["src/entry.ts"]);
    expect(result.entryFiles).toEqual(["src/entry.ts"]);
  });

  it("should handle empty entry paths", () => {
    const result = compiler.compile([]);

    expect(result.files).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("should handle nonexistent entry file", () => {
    const result = compiler.compile(["nonexistent.ts"]);

    expect(result.files).toHaveLength(0);
  });

  it("should handle multiple entry files", () => {
    const result = compiler.compile(["src/entry.ts", "src/utils.ts"]);

    expect(result.files[0].priority).toBe(1.0);
    expect(result.files[1].priority).toBe(1.0);
    expect(result.entryFiles).toEqual(["src/entry.ts", "src/utils.ts"]);
  });

  it("should have token estimates for all included files", () => {
    const result = compiler.compile(["src/entry.ts"]);

    for (const f of result.files) {
      expect(f.tokenEstimate).toBeGreaterThan(0);
    }
  });

  it("should have total tokens equal to sum of file token estimates", () => {
    const result = compiler.compile(["src/entry.ts"], { budget: 100000 });

    const sum = result.files.reduce((acc, f) => acc + f.tokenEstimate, 0);
    expect(result.totalTokens).toBe(sum);
  });
});
