import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type AriadneDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { GraphQueries } from "../refs";

describe("GraphQueries", () => {
  let db: AriadneDB;
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

    // Additional symbols for getCallGraph tests
    store.upsertSymbol({
      id: "sym:caller",
      kind: "function",
      name: "caller",
      file_path: "src/math.ts",
    });
    store.upsertSymbol({
      id: "sym:helper",
      kind: "function",
      name: "helper",
      file_path: "src/math.ts",
    });

    // Call edges: caller -> add -> helper
    store.insertEdge({ source: "sym:caller", target: "sym:add", kind: "calls" });
    store.insertEdge({ source: "sym:add", target: "sym:helper", kind: "calls" });

    // Multi-file occurrence for findRefs tests
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      'import { add } from "./math";\nadd(1, 2);\n',
    );
    store.upsertOccurrence({
      file_path: "src/main.ts",
      range_start: (1 << 16) | 0,
      range_end: (1 << 16) | 3,
      symbol_id: "sym:add",
      roles: 2,
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
      expect(refs).toHaveLength(4); // 1 def + 2 refs in math.ts + 1 ref in main.ts
    });

    it("should exclude definitions when excludeDefinitions is true", () => {
      const refs = graph.findRefs("sym:add", { excludeDefinitions: true });
      expect(refs).toHaveLength(3); // 2 refs in math.ts + 1 ref in main.ts
      for (const ref of refs) {
        expect(ref.roles & 1).toBe(0); // no definition bit set
      }
    });

    it("should filter by scope prefix", () => {
      // Occurrences are in src/math.ts and src/main.ts
      const refs = graph.findRefs("sym:add", { scope: "src/" });
      expect(refs).toHaveLength(4);

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

    it("should apply excludeDefinitions and scope filters simultaneously", () => {
      // Only references (not definitions) within src/ scope
      const refs = graph.findRefs("sym:add", { excludeDefinitions: true, scope: "src/" });
      for (const ref of refs) {
        expect(ref.roles & 1).toBe(0); // no definition bit
        expect(ref.filePath.startsWith("src/")).toBe(true);
      }
      // Should include refs from both src/math.ts and src/main.ts
      expect(refs.length).toBeGreaterThanOrEqual(2);
    });

    it("should return occurrences from multiple files", () => {
      const refs = graph.findRefs("sym:add");
      const files = new Set(refs.map((r) => r.filePath));
      expect(files.size).toBeGreaterThan(1);
      expect(files.has("src/math.ts")).toBe(true);
      expect(files.has("src/main.ts")).toBe(true);
    });

    it("should populate snippets for valid file references", () => {
      const refs = graph.findRefs("sym:add");
      const mathRefs = refs.filter((r) => r.filePath === "src/math.ts");
      // At least the definition occurrence should have a snippet
      expect(mathRefs.some((r) => r.snippet !== undefined)).toBe(true);
    });
  });

  // ── searchSymbol edge cases ───────────────────────────────────────

  describe("searchSymbol edge cases", () => {
    it("should fall back to substring match when prefix doesn't match", () => {
      // "btract" doesn't prefix-match "subtract", but does substring-match
      const results = graph.searchSymbol("btract");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("subtract");
    });

    it("should return undefined kind for symbols without kind", () => {
      store.upsertSymbol({ id: "sym:noKind", name: "noKind" });
      const results = graph.searchSymbol("noKind");
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBeUndefined();
    });
  });

  // ── getDef edge cases ─────────────────────────────────────────────

  describe("getDef edge cases", () => {
    it("should return undefined range and no snippet for symbol without range", () => {
      store.upsertSymbol({ id: "sym:noRange", name: "noRange", kind: "variable", file_path: "src/math.ts" });
      const def = graph.getDef("sym:noRange");
      expect(def).not.toBeNull();
      expect(def!.range).toBeUndefined();
      expect(def!.snippet).toBeUndefined();
    });

    it("should return undefined doc for symbol with null doc", () => {
      store.upsertSymbol({ id: "sym:noDoc", name: "noDoc", kind: "function", file_path: "src/math.ts", range_start: (1 << 16) | 0, range_end: (2 << 16) | 0 });
      const def = graph.getDef("sym:noDoc");
      expect(def).not.toBeNull();
      expect(def!.doc).toBeUndefined();
    });
  });

  // ── getCallGraph ──────────────────────────────────────────────────

  describe("getCallGraph", () => {
    it("should return empty callers/callees for unknown symbol", () => {
      const result = graph.getCallGraph("sym:nonexistent");
      expect(result.root).toBe("sym:nonexistent");
      expect(result.callers).toHaveLength(0);
      expect(result.callees).toHaveLength(0);
    });

    it("should return callers when call edges exist", () => {
      // sym:caller --calls--> sym:add
      const result = graph.getCallGraph("sym:add");
      expect(result.callers).toHaveLength(1);
      expect(result.callers[0].id).toBe("sym:caller");
      expect(result.callers[0].name).toBe("caller");
    });

    it("should return callees when call edges exist", () => {
      // sym:add --calls--> sym:helper
      const result = graph.getCallGraph("sym:add");
      expect(result.callees).toHaveLength(1);
      expect(result.callees[0].id).toBe("sym:helper");
      expect(result.callees[0].name).toBe("helper");
    });

    it("should respect depth parameter (depth=1 stops at direct)", () => {
      // caller -> add -> helper
      // At depth=1 from "add", callers = [caller], callees = [helper]
      const result = graph.getCallGraph("sym:add", 1);
      expect(result.callers).toHaveLength(1);
      expect(result.callees).toHaveLength(1);
    });

    it("should traverse transitively at depth=2", () => {
      // Add a deeper chain: helper -> deepHelper
      store.upsertSymbol({ id: "sym:deepHelper", kind: "function", name: "deepHelper", file_path: "src/math.ts" });
      store.insertEdge({ source: "sym:helper", target: "sym:deepHelper", kind: "calls" });

      // At depth=2 from "add", callees should include both helper and deepHelper
      const result = graph.getCallGraph("sym:add", 2);
      const calleeIds = result.callees.map((c) => c.id);
      expect(calleeIds).toContain("sym:helper");
      expect(calleeIds).toContain("sym:deepHelper");
    });

    it("should handle cycles without infinite loop", () => {
      // Create a cycle: add calls helper, helper calls add (already seeded add -> helper)
      store.insertEdge({ source: "sym:helper", target: "sym:add", kind: "calls" });

      // Should not hang — the seen sets prevent infinite recursion
      const result = graph.getCallGraph("sym:add", 5);
      expect(result.callers.length).toBeGreaterThanOrEqual(1);
      expect(result.callees.length).toBeGreaterThanOrEqual(1);
    });

    it("should return empty when symbol exists but has no call edges", () => {
      const result = graph.getCallGraph("sym:subtract");
      expect(result.root).toBe("sym:subtract");
      expect(result.callers).toHaveLength(0);
      expect(result.callees).toHaveLength(0);
    });

    it("should populate filePath from batch-fetched symbols", () => {
      const result = graph.getCallGraph("sym:add");
      for (const caller of result.callers) {
        expect(caller.filePath).toBe("src/math.ts");
      }
      for (const callee of result.callees) {
        expect(callee.filePath).toBe("src/math.ts");
      }
    });
  });
});
