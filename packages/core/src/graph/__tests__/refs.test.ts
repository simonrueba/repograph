import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type RepographDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { GraphQueries } from "../refs";

describe("GraphQueries", () => {
  let db: RepographDB;
  let store: StoreQueries;
  let graph: GraphQueries;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ariadne-graph-test-"));
    dbPath = join(tempDir, "test.db");
    db = createDatabase(dbPath);
    store = new StoreQueries(db);

    // Create a fake repo root with a source file for snippet reading
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "math.ts"),
      [
        "// math utilities",
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export function subtract(a: number, b: number): number {",
        "  return a - b;",
        "}",
      ].join("\n"),
    );

    // Seed symbols
    // Pack range values: (line << 16 | col)
    store.upsertSymbol({
      id: "sym:add",
      kind: "function",
      name: "add",
      file_path: "src/math.ts",
      range_start: (1 << 16) | 24, // line 1, col 24
      range_end: (3 << 16) | 1, // line 3, col 1
      doc: "Adds two numbers",
    });

    store.upsertSymbol({
      id: "sym:subtract",
      kind: "function",
      name: "subtract",
      file_path: "src/math.ts",
      range_start: (5 << 16) | 24, // line 5, col 24
      range_end: (7 << 16) | 1, // line 7, col 1
    });

    // Seed occurrences for "add":
    // 1 definition (roles=1) + 2 references (roles=2)
    store.upsertOccurrence({
      file_path: "src/math.ts",
      range_start: (1 << 16) | 24,
      range_end: (1 << 16) | 27,
      symbol_id: "sym:add",
      roles: 1, // definition
    });

    store.upsertOccurrence({
      file_path: "src/math.ts",
      range_start: (10 << 16) | 5,
      range_end: (10 << 16) | 8,
      symbol_id: "sym:add",
      roles: 2, // reference
    });

    store.upsertOccurrence({
      file_path: "src/math.ts",
      range_start: (15 << 16) | 10,
      range_end: (15 << 16) | 13,
      symbol_id: "sym:add",
      roles: 2, // reference
    });

    graph = new GraphQueries(store, tempDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── searchSymbol ────────────────────────────────────────────────────

  describe("searchSymbol", () => {
    it('should find symbols matching "add"', () => {
      const results = graph.searchSymbol("add");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("sym:add");
      expect(results[0].name).toBe("add");
      expect(results[0].kind).toBe("function");
      expect(results[0].filePath).toBe("src/math.ts");
    });

    it("should return multiple matches for broader query", () => {
      const results = graph.searchSymbol("sub");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("sym:subtract");
    });

    it("should return empty array for non-matching query", () => {
      const results = graph.searchSymbol("nonexistent");
      expect(results).toHaveLength(0);
    });

    it("should respect the k limit", () => {
      // Add many symbols
      for (let i = 0; i < 20; i++) {
        store.upsertSymbol({ id: `sym:item${i}`, name: `item${i}`, kind: "variable" });
      }
      const results = graph.searchSymbol("item", 5);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it("should unpack range correctly", () => {
      const results = graph.searchSymbol("add");
      expect(results[0].range).toEqual({
        startLine: 1,
        startCol: 24,
        endLine: 3,
        endCol: 1,
      });
    });
  });

  // ── getDef ──────────────────────────────────────────────────────────

  describe("getDef", () => {
    it("should return definition with filePath and doc", () => {
      const def = graph.getDef("sym:add");
      expect(def).not.toBeNull();
      expect(def!.id).toBe("sym:add");
      expect(def!.name).toBe("add");
      expect(def!.filePath).toBe("src/math.ts");
      expect(def!.doc).toBe("Adds two numbers");
    });

    it("should include a code snippet", () => {
      const def = graph.getDef("sym:add");
      expect(def).not.toBeNull();
      expect(def!.snippet).toBeDefined();
      expect(def!.snippet).toContain("export function add");
    });

    it("should return null for unknown symbol", () => {
      const def = graph.getDef("sym:nonexistent");
      expect(def).toBeNull();
    });

    it("should handle symbol without file_path gracefully", () => {
      store.upsertSymbol({ id: "sym:orphan", name: "orphan", kind: "constant" });
      const def = graph.getDef("sym:orphan");
      expect(def).not.toBeNull();
      expect(def!.filePath).toBeUndefined();
      expect(def!.snippet).toBeUndefined();
    });
  });

  // ── findRefs ────────────────────────────────────────────────────────

  describe("findRefs", () => {
    it("should return all occurrences (def + refs) by default", () => {
      const refs = graph.findRefs("sym:add");
      expect(refs).toHaveLength(3);
    });

    it("should exclude definitions when excludeDefinitions is true", () => {
      const refs = graph.findRefs("sym:add", { excludeDefinitions: true });
      expect(refs).toHaveLength(2);
      for (const ref of refs) {
        expect(ref.roles & 1).toBe(0); // no definition bit set
      }
    });

    it("should filter by scope prefix", () => {
      // All occurrences are in src/math.ts
      const refs = graph.findRefs("sym:add", { scope: "src/" });
      expect(refs).toHaveLength(3);

      const refsOther = graph.findRefs("sym:add", { scope: "lib/" });
      expect(refsOther).toHaveLength(0);
    });

    it("should include filePath and range in each result", () => {
      const refs = graph.findRefs("sym:add");
      for (const ref of refs) {
        expect(ref.filePath).toBeDefined();
        expect(ref.range).toBeDefined();
        expect(ref.range.startLine).toBeTypeOf("number");
        expect(ref.range.startCol).toBeTypeOf("number");
        expect(ref.range.endLine).toBeTypeOf("number");
        expect(ref.range.endCol).toBeTypeOf("number");
      }
    });

    it("should return empty array for symbol with no occurrences", () => {
      const refs = graph.findRefs("sym:subtract");
      expect(refs).toHaveLength(0);
    });
  });
});
