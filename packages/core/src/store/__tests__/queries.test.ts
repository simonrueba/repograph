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

  // ── getSymbolsByFile ───────────────────────────────────────────────

  describe("getSymbolsByFile", () => {
    it("should return all symbols in a given file", () => {
      queries.upsertSymbol({ id: "s1", name: "foo", kind: "function", file_path: "src/a.ts" });
      queries.upsertSymbol({ id: "s2", name: "bar", kind: "class", file_path: "src/a.ts" });
      queries.upsertSymbol({ id: "s3", name: "baz", kind: "variable", file_path: "src/b.ts" });

      const result = queries.getSymbolsByFile("src/a.ts");
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.name).sort()).toEqual(["bar", "foo"]);
    });

    it("should return empty array for a file with no symbols", () => {
      expect(queries.getSymbolsByFile("nonexistent.ts")).toEqual([]);
    });
  });

  // ── transaction ───────────────────────────────────────────────────

  describe("transaction", () => {
    it("should commit on success", () => {
      queries.transaction(() => {
        queries.upsertSymbol({ id: "t1", name: "txn", kind: "function" });
      });
      expect(queries.getSymbol("t1")).not.toBeNull();
    });

    it("should rollback on error", () => {
      try {
        queries.transaction(() => {
          queries.upsertSymbol({ id: "t2", name: "rollback", kind: "function" });
          throw new Error("fail");
        });
      } catch { /* expected */ }
      expect(queries.getSymbol("t2")).toBeNull();
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

  // ── Projects ───────────────────────────────────────────────────────

  describe("Projects", () => {
    it("should upsert and get a project (round-trip)", () => {
      queries.upsertProject({
        project_id: "packages/core",
        root: "/repo/packages/core",
        language: "typescript",
        last_index_ts: 1000,
      });

      const project = queries.getProject("packages/core");

      expect(project).not.toBeNull();
      expect(project!.project_id).toBe("packages/core");
      expect(project!.root).toBe("/repo/packages/core");
      expect(project!.language).toBe("typescript");
      expect(project!.last_index_ts).toBe(1000);
    });

    it("should return null for a missing project", () => {
      const project = queries.getProject("nonexistent");
      expect(project).toBeNull();
    });

    it("should update existing project fields on re-upsert", () => {
      queries.upsertProject({
        project_id: "packages/core",
        root: "/repo/packages/core",
        language: "typescript",
        last_index_ts: 1000,
      });

      // Re-upsert with updated values
      queries.upsertProject({
        project_id: "packages/core",
        root: "/repo/packages/core-renamed",
        language: "python",
        last_index_ts: 9999,
      });

      const project = queries.getProject("packages/core");
      expect(project!.root).toBe("/repo/packages/core-renamed");
      expect(project!.language).toBe("python");
      expect(project!.last_index_ts).toBe(9999);
    });

    it("should return all registered projects via getAllProjects", () => {
      queries.upsertProject({
        project_id: "packages/app",
        root: "/repo/packages/app",
        language: "typescript",
        last_index_ts: 0,
      });
      queries.upsertProject({
        project_id: "packages/lib",
        root: "/repo/packages/lib",
        language: "typescript",
        last_index_ts: 0,
      });
      queries.upsertProject({
        project_id: "services/ml",
        root: "/repo/services/ml",
        language: "python",
        last_index_ts: 0,
      });

      const projects = queries.getAllProjects();

      expect(projects).toHaveLength(3);

      const ids = projects.map((p) => p.project_id).sort();
      expect(ids).toEqual(["packages/app", "packages/lib", "services/ml"]);
    });

    it("should return an empty array when no projects are registered", () => {
      expect(queries.getAllProjects()).toHaveLength(0);
    });

    it("should update last_index_ts via setProjectIndexTs", () => {
      queries.upsertProject({
        project_id: "packages/core",
        root: "/repo/packages/core",
        language: "typescript",
        last_index_ts: 0,
      });

      queries.setProjectIndexTs("packages/core", 42000);

      const project = queries.getProject("packages/core");
      expect(project!.last_index_ts).toBe(42000);
    });

    it("should leave other project fields unchanged after setProjectIndexTs", () => {
      queries.upsertProject({
        project_id: "packages/core",
        root: "/repo/packages/core",
        language: "typescript",
        last_index_ts: 0,
      });

      queries.setProjectIndexTs("packages/core", 99999);

      const project = queries.getProject("packages/core");
      expect(project!.root).toBe("/repo/packages/core");
      expect(project!.language).toBe("typescript");
    });

    it("setProjectIndexTs is a no-op for a project_id that does not exist", () => {
      // Should not throw; no rows updated
      expect(() =>
        queries.setProjectIndexTs("nonexistent", 12345),
      ).not.toThrow();
    });

    // ── getProjectForPath ─────────────────────────────────────────────

    it("should return the matching project for a file directly under its root", () => {
      queries.upsertProject({
        project_id: "packages/core",
        root: "/repo/packages/core",
        language: "typescript",
        last_index_ts: 0,
      });

      const project = queries.getProjectForPath(
        "/repo/packages/core/src/index.ts",
      );

      expect(project).not.toBeNull();
      expect(project!.project_id).toBe("packages/core");
    });

    it("should return the most specific (deepest) matching project", () => {
      // Shallow project covers the whole packages/ tree
      queries.upsertProject({
        project_id: ".",
        root: "/repo",
        language: "typescript",
        last_index_ts: 0,
      });
      // Deeper project that is a more specific match
      queries.upsertProject({
        project_id: "packages/core",
        root: "/repo/packages/core",
        language: "typescript",
        last_index_ts: 0,
      });

      const project = queries.getProjectForPath(
        "/repo/packages/core/src/index.ts",
      );

      expect(project!.project_id).toBe("packages/core");
    });

    it("should return the root project when the file does not belong to any deeper project", () => {
      queries.upsertProject({
        project_id: ".",
        root: "/repo",
        language: "typescript",
        last_index_ts: 0,
      });
      queries.upsertProject({
        project_id: "packages/core",
        root: "/repo/packages/core",
        language: "typescript",
        last_index_ts: 0,
      });

      // File is under /repo but NOT under /repo/packages/core
      const project = queries.getProjectForPath("/repo/src/main.ts");

      expect(project!.project_id).toBe(".");
    });

    it("should return null when no project matches the given path", () => {
      queries.upsertProject({
        project_id: "packages/core",
        root: "/repo/packages/core",
        language: "typescript",
        last_index_ts: 0,
      });

      // File lives outside the registered project tree
      const project = queries.getProjectForPath("/other/completely/different/path.ts");

      expect(project).toBeNull();
    });

    it("should return null when no projects are registered", () => {
      const project = queries.getProjectForPath("/repo/src/index.ts");
      expect(project).toBeNull();
    });

    it("should handle a file path that exactly equals the project root", () => {
      queries.upsertProject({
        project_id: "packages/core",
        root: "/repo/packages/core",
        language: "typescript",
        last_index_ts: 0,
      });

      const project = queries.getProjectForPath("/repo/packages/core");

      expect(project).not.toBeNull();
      expect(project!.project_id).toBe("packages/core");
    });
  });
});
