import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SymbolRole } from "../types";
import { ScipParser } from "../parser";
import { createDatabase, type RepographDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";

describe("ScipParser call edge derivation", () => {
  let db: RepographDB;
  let store: StoreQueries;
  const tempDirs: string[] = [];

  function makeTempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-calls-test-"));
    tempDirs.push(dir);
    return join(dir, "test.db");
  }

  beforeEach(() => {
    db = createDatabase(makeTempDb());
    store = new StoreQueries(db);
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("should emit a calls edge when a reference occurs inside a definition range", () => {
    const parser = new ScipParser();

    // foo is defined at lines 0-10, bar is defined at lines 0-5 in another file.
    // A reference to bar inside foo's range should produce a foo->bar call edge.
    const mockIndex = {
      documents: [
        {
          relativePath: "src/caller.ts",
          language: "typescript",
          symbols: [
            { symbol: "pkg . foo().", kind: 17, displayName: "foo" },
          ],
          occurrences: [
            {
              // foo definition: lines 0-10
              symbol: "pkg . foo().",
              range: [0, 0, 10, 0],
              symbolRoles: SymbolRole.Definition,
            },
            {
              // reference to bar inside foo's body (line 5)
              symbol: "pkg . bar().",
              range: [5, 4, 7],
              symbolRoles: SymbolRole.ReadAccess,
            },
          ],
        },
        {
          relativePath: "src/callee.ts",
          language: "typescript",
          symbols: [
            { symbol: "pkg . bar().", kind: 17, displayName: "bar" },
          ],
          occurrences: [
            {
              // bar definition: lines 0-5
              symbol: "pkg . bar().",
              range: [0, 0, 5, 0],
              symbolRoles: SymbolRole.Definition,
            },
          ],
        },
      ],
    };

    parser.ingest(mockIndex, store, "/repo");

    // Check that a "calls" edge from foo -> bar was created
    const callEdges = store
      .getEdgesBySource("pkg . foo().")
      .filter((e) => e.kind === "calls");

    expect(callEdges).toHaveLength(1);
    expect(callEdges[0].source).toBe("pkg . foo().");
    expect(callEdges[0].target).toBe("pkg . bar().");
    expect(callEdges[0].confidence).toBe("approximate");
  });

  it("should not emit a calls edge when a symbol references itself", () => {
    const parser = new ScipParser();

    const mockIndex = {
      documents: [
        {
          relativePath: "src/recursive.ts",
          language: "typescript",
          symbols: [
            { symbol: "pkg . recurse().", kind: 17, displayName: "recurse" },
          ],
          occurrences: [
            {
              symbol: "pkg . recurse().",
              range: [0, 0, 10, 0],
              symbolRoles: SymbolRole.Definition,
            },
            {
              // recursive call to itself
              symbol: "pkg . recurse().",
              range: [5, 4, 11],
              symbolRoles: SymbolRole.ReadAccess,
            },
          ],
        },
      ],
    };

    parser.ingest(mockIndex, store, "/repo");

    const callEdges = store
      .getEdgesBySource("pkg . recurse().")
      .filter((e) => e.kind === "calls");

    expect(callEdges).toHaveLength(0);
  });

  it("should deduplicate call edges for multiple references to the same target", () => {
    const parser = new ScipParser();

    const mockIndex = {
      documents: [
        {
          relativePath: "src/multi.ts",
          language: "typescript",
          symbols: [
            { symbol: "pkg . caller().", kind: 17, displayName: "caller" },
          ],
          occurrences: [
            {
              symbol: "pkg . caller().",
              range: [0, 0, 20, 0],
              symbolRoles: SymbolRole.Definition,
            },
            {
              symbol: "pkg . target().",
              range: [5, 4, 10],
              symbolRoles: SymbolRole.ReadAccess,
            },
            {
              // second reference to same target
              symbol: "pkg . target().",
              range: [10, 4, 10],
              symbolRoles: SymbolRole.ReadAccess,
            },
          ],
        },
      ],
    };

    parser.ingest(mockIndex, store, "/repo");

    const callEdges = store
      .getEdgesBySource("pkg . caller().")
      .filter((e) => e.kind === "calls");

    expect(callEdges).toHaveLength(1);
  });

  it("should pick the innermost enclosing definition for nested scopes", () => {
    const parser = new ScipParser();

    // outer contains inner; inner contains a reference to target.
    // The call edge should be inner->target, not outer->target.
    const mockIndex = {
      documents: [
        {
          relativePath: "src/nested.ts",
          language: "typescript",
          symbols: [
            { symbol: "pkg . outer().", kind: 17, displayName: "outer" },
            { symbol: "pkg . inner().", kind: 17, displayName: "inner" },
          ],
          occurrences: [
            {
              symbol: "pkg . outer().",
              range: [0, 0, 20, 0],
              symbolRoles: SymbolRole.Definition,
            },
            {
              symbol: "pkg . inner().",
              range: [5, 2, 15, 2],
              symbolRoles: SymbolRole.Definition,
            },
            {
              // reference to target inside inner's range
              symbol: "pkg . target().",
              range: [10, 4, 10],
              symbolRoles: SymbolRole.ReadAccess,
            },
          ],
        },
      ],
    };

    parser.ingest(mockIndex, store, "/repo");

    const innerCalls = store
      .getEdgesBySource("pkg . inner().")
      .filter((e) => e.kind === "calls");
    const outerCalls = store
      .getEdgesBySource("pkg . outer().")
      .filter((e) => e.kind === "calls");

    expect(innerCalls).toHaveLength(1);
    expect(innerCalls[0].target).toBe("pkg . target().");

    // outer should also have a call to inner (the definition of inner is inside outer,
    // but inner's definition is not a reference — only the target reference matters)
    // outer should have a call to target only if there's a reference outside inner's range
    // In this case, the reference is inside inner, so outer should NOT have a call to target
    expect(outerCalls.filter((e) => e.target === "pkg . target().")).toHaveLength(0);
  });
});
