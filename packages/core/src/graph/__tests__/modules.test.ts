import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type RepographDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { ModuleGraph } from "../modules";

describe("ModuleGraph", () => {
  let db: RepographDB;
  let store: StoreQueries;
  let moduleGraph: ModuleGraph;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "repograph-modules-test-"));
    db = createDatabase(join(tempDir, "test.db"));
    store = new StoreQueries(db);

    // Seed 3 files
    store.upsertFile({ path: "src/index.ts", language: "typescript", hash: "h1" });
    store.upsertFile({ path: "src/math.ts", language: "typescript", hash: "h2" });
    store.upsertFile({ path: "src/utils/helpers.ts", language: "typescript", hash: "h3" });

    // Seed 2 import edges
    store.insertEdge({
      source: "src/index.ts",
      target: "src/math.ts",
      kind: "imports",
    });
    store.insertEdge({
      source: "src/index.ts",
      target: "src/utils/helpers.ts",
      kind: "imports",
    });

    moduleGraph = new ModuleGraph(store);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getGraph", () => {
    it("should return all nodes and edges for the full graph", () => {
      const result = moduleGraph.getGraph();
      expect(result.nodes).toHaveLength(3);
      expect(result.edges).toHaveLength(2);

      const paths = result.nodes.map((n) => n.path);
      expect(paths).toContain("src/index.ts");
      expect(paths).toContain("src/math.ts");
      expect(paths).toContain("src/utils/helpers.ts");
    });

    it("should include language in each node", () => {
      const result = moduleGraph.getGraph();
      for (const node of result.nodes) {
        expect(node.language).toBe("typescript");
      }
    });

    it("should include from, to, and kind in each edge", () => {
      const result = moduleGraph.getGraph();
      for (const edge of result.edges) {
        expect(edge.from).toBeDefined();
        expect(edge.to).toBeDefined();
        expect(edge.kind).toBe("imports");
      }
    });

    it("should filter nodes by scope path", () => {
      const result = moduleGraph.getGraph("src/utils/");
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].path).toBe("src/utils/helpers.ts");
    });

    it("should only include edges from scoped nodes", () => {
      // src/utils/helpers.ts has no outbound import edges
      const result = moduleGraph.getGraph("src/utils/");
      expect(result.edges).toHaveLength(0);
    });

    it("should return edges from scoped nodes that point outside scope", () => {
      // Add an edge from helpers.ts to math.ts
      store.insertEdge({
        source: "src/utils/helpers.ts",
        target: "src/math.ts",
        kind: "imports",
      });

      const result = moduleGraph.getGraph("src/utils/");
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].from).toBe("src/utils/helpers.ts");
      expect(result.edges[0].to).toBe("src/math.ts");
    });

    it("should only include imports and exports edges", () => {
      // Add a non-import/export edge
      store.insertEdge({
        source: "src/index.ts",
        target: "src/math.ts",
        kind: "calls",
      });

      const result = moduleGraph.getGraph();
      // Still only 2 import edges, not the "calls" edge
      expect(result.edges).toHaveLength(2);
      for (const edge of result.edges) {
        expect(["imports", "exports"]).toContain(edge.kind);
      }
    });

    it("should match exact file path as scope", () => {
      const result = moduleGraph.getGraph("src/index.ts");
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].path).toBe("src/index.ts");
      expect(result.edges).toHaveLength(2); // index.ts has 2 outbound imports
    });

    it("should return empty graph for non-matching scope", () => {
      const result = moduleGraph.getGraph("lib/");
      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });
  });
});
