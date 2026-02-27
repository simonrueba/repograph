import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type RepographDB } from "../db";
import { StoreQueries } from "../queries";

describe("StoreQueries call edge queries", () => {
  let db: RepographDB;
  let queries: StoreQueries;
  const tempDirs: string[] = [];

  function makeTempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-calls-query-test-"));
    tempDirs.push(dir);
    return join(dir, "test.db");
  }

  beforeEach(() => {
    db = createDatabase(makeTempDb());
    queries = new StoreQueries(db);

    // Seed some call edges
    queries.insertEdge({ source: "sym:foo", target: "sym:bar", kind: "calls", confidence: "approximate" });
    queries.insertEdge({ source: "sym:foo", target: "sym:baz", kind: "calls", confidence: "approximate" });
    queries.insertEdge({ source: "sym:qux", target: "sym:foo", kind: "calls", confidence: "approximate" });
    // Non-call edge — should not appear in getCallees/getCallers
    queries.insertEdge({ source: "sym:foo", target: "sym:other", kind: "references", confidence: "high" });
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  describe("getCallees", () => {
    it("should return only 'calls' edges for the given source", () => {
      const callees = queries.getCallees("sym:foo");
      expect(callees).toHaveLength(2);
      expect(callees.map((e) => e.target).sort()).toEqual(["sym:bar", "sym:baz"]);
    });

    it("should return empty array for a symbol with no callees", () => {
      const callees = queries.getCallees("sym:bar");
      expect(callees).toHaveLength(0);
    });

    it("should not include non-call edges", () => {
      const callees = queries.getCallees("sym:foo");
      expect(callees.every((e) => e.kind === "calls")).toBe(true);
      expect(callees.map((e) => e.target)).not.toContain("sym:other");
    });
  });

  describe("getCallers", () => {
    it("should return only 'calls' edges for the given target", () => {
      const callers = queries.getCallers("sym:foo");
      expect(callers).toHaveLength(1);
      expect(callers[0].source).toBe("sym:qux");
    });

    it("should return all callers when there are multiple", () => {
      const callers = queries.getCallers("sym:bar");
      expect(callers).toHaveLength(1);
      expect(callers[0].source).toBe("sym:foo");
    });

    it("should return empty array for a symbol with no callers", () => {
      const callers = queries.getCallers("sym:qux");
      expect(callers).toHaveLength(0);
    });
  });
});
