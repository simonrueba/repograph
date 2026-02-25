import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type RepographDB } from "../db";
import { StoreQueries } from "../queries";

describe("StoreQueries", () => {
  let db: RepographDB;
  let queries: StoreQueries;
  const tempDirs: string[] = [];

  function makeTempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "repograph-query-test-"));
    tempDirs.push(dir);
    return join(dir, "test.db");
  }

  beforeEach(() => {
    db = createDatabase(makeTempDb());
    queries = new StoreQueries(db);
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  // ── Files ──────────────────────────────────────────────────────────

  describe("files", () => {
    it("should upsert and get a file", () => {
      queries.upsertFile({ path: "src/a.ts", language: "typescript", hash: "abc123" });
      const file = queries.getFile("src/a.ts");

      expect(file).not.toBeNull();
      expect(file!.path).toBe("src/a.ts");
      expect(file!.language).toBe("typescript");
      expect(file!.hash).toBe("abc123");
      expect(file!.indexed_at).toBeTypeOf("number");
    });

    it("should return null for a missing file", () => {
      const file = queries.getFile("nonexistent.ts");
      expect(file).toBeNull();
    });

    it("should update hash on re-upsert", () => {
      queries.upsertFile({ path: "src/a.ts", language: "typescript", hash: "v1" });
      queries.upsertFile({ path: "src/a.ts", language: "typescript", hash: "v2" });

      const file = queries.getFile("src/a.ts");
      expect(file!.hash).toBe("v2");
    });

    it("should get all files", () => {
      queries.upsertFile({ path: "a.ts", language: "typescript", hash: "h1" });
      queries.upsertFile({ path: "b.py", language: "python", hash: "h2" });

      const files = queries.getAllFiles();
      expect(files).toHaveLength(2);
    });

    it("should find stale files", () => {
      queries.upsertFile({ path: "a.ts", language: "typescript", hash: "old" });
      queries.upsertFile({ path: "b.ts", language: "typescript", hash: "same" });

      const stale = queries.findStaleFiles([
        { path: "a.ts", hash: "new" }, // hash changed → stale
        { path: "b.ts", hash: "same" }, // hash same → not stale
        { path: "c.ts", hash: "brand_new" }, // new file → stale
      ]);

      expect(stale).toContain("a.ts");
      expect(stale).toContain("c.ts");
      expect(stale).not.toContain("b.ts");
    });

    it("should delete a file", () => {
      queries.upsertFile({ path: "a.ts", language: "typescript", hash: "h1" });
      queries.deleteFile("a.ts");

      expect(queries.getFile("a.ts")).toBeNull();
    });
  });

  // ── Symbols ────────────────────────────────────────────────────────

  describe("symbols", () => {
    it("should upsert and get a symbol", () => {
      queries.upsertSymbol({
        id: "sym1",
        kind: "function",
        name: "doStuff",
        file_path: "a.ts",
        range_start: 10,
        range_end: 50,
        doc: "Does stuff",
      });

      const sym = queries.getSymbol("sym1");
      expect(sym).not.toBeNull();
      expect(sym!.name).toBe("doStuff");
      expect(sym!.kind).toBe("function");
      expect(sym!.doc).toBe("Does stuff");
    });

    it("should return null for missing symbol", () => {
      expect(queries.getSymbol("nope")).toBeNull();
    });

    it("should update symbol on re-upsert", () => {
      queries.upsertSymbol({ id: "sym1", name: "oldName", kind: "function" });
      queries.upsertSymbol({ id: "sym1", name: "newName", kind: "class" });

      const sym = queries.getSymbol("sym1");
      expect(sym!.name).toBe("newName");
      expect(sym!.kind).toBe("class");
    });

    it("should search symbols by name", () => {
      queries.upsertSymbol({ id: "s1", name: "handleClick", kind: "function" });
      queries.upsertSymbol({ id: "s2", name: "handleSubmit", kind: "function" });
      queries.upsertSymbol({ id: "s3", name: "render", kind: "function" });

      const results = queries.searchSymbols("handle");
      expect(results).toHaveLength(2);
      expect(results.map((s) => s.name)).toContain("handleClick");
      expect(results.map((s) => s.name)).toContain("handleSubmit");
    });

    it("should return empty array for no search matches", () => {
      queries.upsertSymbol({ id: "s1", name: "foo", kind: "function" });
      expect(queries.searchSymbols("zzzzz")).toEqual([]);
    });
  });

  // ── Occurrences ────────────────────────────────────────────────────

  describe("occurrences", () => {
    it("should upsert and query occurrences by symbol", () => {
      queries.upsertOccurrence({
        file_path: "a.ts",
        range_start: 10,
        range_end: 20,
        symbol_id: "sym1",
        roles: 1,
      });
      queries.upsertOccurrence({
        file_path: "b.ts",
        range_start: 30,
        range_end: 40,
        symbol_id: "sym1",
        roles: 2,
      });

      const occs = queries.getOccurrencesBySymbol("sym1");
      expect(occs).toHaveLength(2);
    });

    it("should query occurrences by file", () => {
      queries.upsertOccurrence({
        file_path: "a.ts",
        range_start: 10,
        range_end: 20,
        symbol_id: "sym1",
        roles: 1,
      });
      queries.upsertOccurrence({
        file_path: "a.ts",
        range_start: 50,
        range_end: 60,
        symbol_id: "sym2",
        roles: 1,
      });

      const occs = queries.getOccurrencesByFile("a.ts");
      expect(occs).toHaveLength(2);
    });

    it("should clear occurrences for a file", () => {
      queries.upsertOccurrence({
        file_path: "a.ts",
        range_start: 10,
        range_end: 20,
        symbol_id: "sym1",
        roles: 1,
      });
      queries.upsertOccurrence({
        file_path: "b.ts",
        range_start: 10,
        range_end: 20,
        symbol_id: "sym1",
        roles: 1,
      });

      queries.clearOccurrencesForFile("a.ts");

      expect(queries.getOccurrencesByFile("a.ts")).toHaveLength(0);
      expect(queries.getOccurrencesByFile("b.ts")).toHaveLength(1);
    });

    it("should replace occurrence on conflict", () => {
      queries.upsertOccurrence({
        file_path: "a.ts",
        range_start: 10,
        range_end: 20,
        symbol_id: "sym1",
        roles: 1,
      });
      // Same PK, different roles
      queries.upsertOccurrence({
        file_path: "a.ts",
        range_start: 10,
        range_end: 25,
        symbol_id: "sym1",
        roles: 3,
      });

      const occs = queries.getOccurrencesBySymbol("sym1");
      expect(occs).toHaveLength(1);
      expect(occs[0].roles).toBe(3);
    });
  });

  // ── Edges ──────────────────────────────────────────────────────────

  describe("edges", () => {
    it("should insert and get edges by source", () => {
      queries.insertEdge({ source: "sym1", target: "sym2", kind: "calls" });
      queries.insertEdge({ source: "sym1", target: "sym3", kind: "imports" });

      const edges = queries.getEdgesBySource("sym1");
      expect(edges).toHaveLength(2);
      expect(edges.map((e) => e.target)).toContain("sym2");
      expect(edges.map((e) => e.target)).toContain("sym3");
    });

    it("should get edges by target", () => {
      queries.insertEdge({ source: "sym1", target: "sym2", kind: "calls" });
      queries.insertEdge({ source: "sym3", target: "sym2", kind: "calls" });

      const edges = queries.getEdgesByTarget("sym2");
      expect(edges).toHaveLength(2);
    });

    it("should default confidence to 'high'", () => {
      queries.insertEdge({ source: "a", target: "b", kind: "calls" });

      const edges = queries.getEdgesBySource("a");
      expect(edges[0].confidence).toBe("high");
    });

    it("should allow custom confidence", () => {
      queries.insertEdge({
        source: "a",
        target: "b",
        kind: "calls",
        confidence: "low",
      });

      const edges = queries.getEdgesBySource("a");
      expect(edges[0].confidence).toBe("low");
    });

    it("should clear edges for a file (source)", () => {
      queries.insertEdge({ source: "file:a.ts", target: "sym1", kind: "contains" });
      queries.insertEdge({ source: "file:b.ts", target: "sym2", kind: "contains" });

      queries.clearEdgesForFile("file:a.ts");

      expect(queries.getEdgesBySource("file:a.ts")).toHaveLength(0);
      expect(queries.getEdgesBySource("file:b.ts")).toHaveLength(1);
    });

    it("should clear all edges", () => {
      queries.insertEdge({ source: "a", target: "b", kind: "calls" });
      queries.insertEdge({ source: "c", target: "d", kind: "imports" });

      queries.clearAllEdges();

      expect(queries.getEdgesBySource("a")).toHaveLength(0);
      expect(queries.getEdgesBySource("c")).toHaveLength(0);
    });

    it("should clear all symbols", () => {
      queries.upsertSymbol({ id: "s1", name: "foo", kind: "function" });
      queries.upsertSymbol({ id: "s2", name: "bar", kind: "class" });

      queries.clearAllSymbols();

      expect(queries.getSymbol("s1")).toBeNull();
      expect(queries.getSymbol("s2")).toBeNull();
    });

    it("should clear all occurrences", () => {
      queries.upsertOccurrence({
        file_path: "a.ts",
        range_start: 10,
        range_end: 20,
        symbol_id: "sym1",
        roles: 1,
      });

      queries.clearAllOccurrences();

      expect(queries.getOccurrencesByFile("a.ts")).toHaveLength(0);
    });
  });
});
