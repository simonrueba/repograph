import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type AriadneDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { GraphQueries } from "../refs";

describe("GraphQueries.getCallGraph", () => {
  let db: AriadneDB;
  let store: StoreQueries;
  let graph: GraphQueries;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ariadne-callgraph-test-"));
    const dbPath = join(tempDir, "test.db");
    db = createDatabase(dbPath);
    store = new StoreQueries(db);

    // Seed symbols
    store.upsertSymbol({ id: "sym:main", name: "main", kind: "function", file_path: "src/main.ts" });
    store.upsertSymbol({ id: "sym:helper", name: "helper", kind: "function", file_path: "src/helper.ts" });
    store.upsertSymbol({ id: "sym:utils", name: "utils", kind: "function", file_path: "src/utils.ts" });
    store.upsertSymbol({ id: "sym:deep", name: "deep", kind: "function", file_path: "src/deep.ts" });

    // Call graph: main -> helper -> utils -> deep
    store.insertEdge({ source: "sym:main", target: "sym:helper", kind: "calls", confidence: "approximate" });
    store.insertEdge({ source: "sym:helper", target: "sym:utils", kind: "calls", confidence: "approximate" });
    store.insertEdge({ source: "sym:utils", target: "sym:deep", kind: "calls", confidence: "approximate" });

    graph = new GraphQueries(store, tempDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return callers and callees at depth 1", () => {
    const result = graph.getCallGraph("sym:helper", 1);

    expect(result.root).toBe("sym:helper");
    expect(result.callers).toHaveLength(1);
    expect(result.callers[0].id).toBe("sym:main");
    expect(result.callers[0].name).toBe("main");

    expect(result.callees).toHaveLength(1);
    expect(result.callees[0].id).toBe("sym:utils");
    expect(result.callees[0].name).toBe("utils");
  });

  it("should traverse deeper with higher depth", () => {
    const result = graph.getCallGraph("sym:helper", 3);

    expect(result.callers).toHaveLength(1); // only main calls helper
    expect(result.callees).toHaveLength(2); // utils and deep
    expect(result.callees.map((c) => c.id).sort()).toEqual(["sym:deep", "sym:utils"]);
  });

  it("should return empty callers/callees for a leaf symbol", () => {
    const result = graph.getCallGraph("sym:deep", 1);

    expect(result.root).toBe("sym:deep");
    expect(result.callers).toHaveLength(1); // utils calls deep
    expect(result.callees).toHaveLength(0); // deep calls nothing
  });

  it("should return empty callers/callees for root symbol", () => {
    const result = graph.getCallGraph("sym:main", 1);

    expect(result.root).toBe("sym:main");
    expect(result.callers).toHaveLength(0); // nobody calls main
    expect(result.callees).toHaveLength(1); // main calls helper
    expect(result.callees[0].id).toBe("sym:helper");
  });

  it("should return empty results for an unknown symbol", () => {
    const result = graph.getCallGraph("sym:nonexistent", 1);

    expect(result.root).toBe("sym:nonexistent");
    expect(result.callers).toHaveLength(0);
    expect(result.callees).toHaveLength(0);
  });

  it("should include filePath when symbol has one", () => {
    const result = graph.getCallGraph("sym:helper", 1);

    expect(result.callers[0].filePath).toBe("src/main.ts");
    expect(result.callees[0].filePath).toBe("src/utils.ts");
  });

  it("should handle depth 0 by returning empty callers/callees", () => {
    const result = graph.getCallGraph("sym:helper", 0);

    expect(result.root).toBe("sym:helper");
    expect(result.callers).toHaveLength(0);
    expect(result.callees).toHaveLength(0);
  });

  it("should not produce duplicates in a diamond call pattern", () => {
    // Add a second path: main -> utils (in addition to main -> helper -> utils)
    store.insertEdge({ source: "sym:main", target: "sym:utils", kind: "calls", confidence: "approximate" });

    const result = graph.getCallGraph("sym:main", 3);

    // utils should appear only once in callees despite two paths
    const utilsEntries = result.callees.filter((c) => c.id === "sym:utils");
    expect(utilsEntries).toHaveLength(1);
  });
});
