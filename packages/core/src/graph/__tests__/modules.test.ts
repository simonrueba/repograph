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

  // ── Semantic mode ────────────────────────────────────────────────────

  describe("getGraph — semantic mode", () => {
    /**
     * Seed occurrence data for semantic edge tests.
     *
     * Symbol "sym:add" is defined in src/math.ts and referenced in src/index.ts.
     * Symbol "sym:log" is defined in src/utils/helpers.ts and referenced in src/index.ts.
     *
     * Expected semantic edges:
     *   src/index.ts → src/math.ts        (weight 1, via sym:add)
     *   src/index.ts → src/utils/helpers.ts (weight 1, via sym:log)
     */
    function seedSemanticData(): void {
      // Define sym:add in src/math.ts
      store.upsertSymbol({
        id: "sym:add",
        kind: "function",
        name: "add",
        file_path: "src/math.ts",
        range_start: 0,
        range_end: 30,
      });
      // Definition occurrence (bit 0 set — roles = 1)
      store.upsertOccurrence({
        file_path: "src/math.ts",
        range_start: 0,
        range_end: 30,
        symbol_id: "sym:add",
        roles: 1,
      });
      // Reference occurrence in src/index.ts (roles = 2, no definition bit)
      store.upsertOccurrence({
        file_path: "src/index.ts",
        range_start: 5,
        range_end: 15,
        symbol_id: "sym:add",
        roles: 2,
      });

      // Define sym:log in src/utils/helpers.ts
      store.upsertSymbol({
        id: "sym:log",
        kind: "function",
        name: "log",
        file_path: "src/utils/helpers.ts",
        range_start: 0,
        range_end: 20,
      });
      // Definition occurrence (roles = 1)
      store.upsertOccurrence({
        file_path: "src/utils/helpers.ts",
        range_start: 0,
        range_end: 20,
        symbol_id: "sym:log",
        roles: 1,
      });
      // Reference occurrence in src/index.ts (roles = 2)
      store.upsertOccurrence({
        file_path: "src/index.ts",
        range_start: 20,
        range_end: 30,
        symbol_id: "sym:log",
        roles: 2,
      });
    }

    it("should build edges from occurrences — referencing file to definition file", () => {
      seedSemanticData();
      const result = moduleGraph.getGraph(undefined, "semantic");

      const edges = result.edges;
      // src/index.ts references symbols defined in src/math.ts and src/utils/helpers.ts
      const froms = edges.map((e) => e.from);
      const tos = edges.map((e) => e.to);
      expect(froms).toContain("src/index.ts");
      expect(tos).toContain("src/math.ts");
      expect(tos).toContain("src/utils/helpers.ts");
    });

    it("should include weight equal to count of distinct shared symbols", () => {
      seedSemanticData();
      // Add a second symbol also defined in src/math.ts and referenced in src/index.ts
      store.upsertSymbol({
        id: "sym:subtract",
        kind: "function",
        name: "subtract",
        file_path: "src/math.ts",
        range_start: 40,
        range_end: 70,
      });
      store.upsertOccurrence({
        file_path: "src/math.ts",
        range_start: 40,
        range_end: 70,
        symbol_id: "sym:subtract",
        roles: 1,
      });
      store.upsertOccurrence({
        file_path: "src/index.ts",
        range_start: 35,
        range_end: 45,
        symbol_id: "sym:subtract",
        roles: 2,
      });

      const result = moduleGraph.getGraph(undefined, "semantic");
      const edge = result.edges.find(
        (e) => e.from === "src/index.ts" && e.to === "src/math.ts",
      );
      expect(edge).toBeDefined();
      // Two distinct symbols referenced: sym:add and sym:subtract
      expect(edge!.weight).toBe(2);
    });

    it("should not include edges for same-file references", () => {
      // Place a reference to sym:add inside src/math.ts itself (same file as definition)
      store.upsertSymbol({
        id: "sym:add",
        kind: "function",
        name: "add",
        file_path: "src/math.ts",
        range_start: 0,
        range_end: 30,
      });
      store.upsertOccurrence({
        file_path: "src/math.ts",
        range_start: 0,
        range_end: 30,
        symbol_id: "sym:add",
        roles: 1,
      });
      // Self-reference inside the same file (not a definition)
      store.upsertOccurrence({
        file_path: "src/math.ts",
        range_start: 50,
        range_end: 60,
        symbol_id: "sym:add",
        roles: 2,
      });

      const result = moduleGraph.getGraph(undefined, "semantic");
      const selfEdges = result.edges.filter(
        (e) => e.from === "src/math.ts" && e.to === "src/math.ts",
      );
      expect(selfEdges).toHaveLength(0);
    });

    it("should emit kind='semantic' for all edges", () => {
      seedSemanticData();
      const result = moduleGraph.getGraph(undefined, "semantic");
      for (const edge of result.edges) {
        expect(edge.kind).toBe("semantic");
      }
    });
  });

  // ── Hybrid mode ──────────────────────────────────────────────────────

  describe("getGraph — hybrid mode", () => {
    /**
     * Seed data where src/index.ts imports src/math.ts (structural) AND
     * references a symbol defined there (semantic), so the edge should be
     * tagged "import+semantic".  The import edge to src/utils/helpers.ts
     * exists only structurally, while a semantic-only edge exists from
     * src/math.ts to src/utils/helpers.ts via a symbol reference.
     */
    function seedHybridData(): void {
      // Symbol defined in src/math.ts, referenced in src/index.ts
      store.upsertSymbol({
        id: "sym:add",
        kind: "function",
        name: "add",
        file_path: "src/math.ts",
        range_start: 0,
        range_end: 30,
      });
      store.upsertOccurrence({
        file_path: "src/math.ts",
        range_start: 0,
        range_end: 30,
        symbol_id: "sym:add",
        roles: 1,
      });
      store.upsertOccurrence({
        file_path: "src/index.ts",
        range_start: 5,
        range_end: 15,
        symbol_id: "sym:add",
        roles: 2,
      });

      // Symbol defined in src/utils/helpers.ts, referenced in src/math.ts only
      // (no structural import edge between them — purely semantic)
      store.upsertSymbol({
        id: "sym:log",
        kind: "function",
        name: "log",
        file_path: "src/utils/helpers.ts",
        range_start: 0,
        range_end: 20,
      });
      store.upsertOccurrence({
        file_path: "src/utils/helpers.ts",
        range_start: 0,
        range_end: 20,
        symbol_id: "sym:log",
        roles: 1,
      });
      store.upsertOccurrence({
        file_path: "src/math.ts",
        range_start: 40,
        range_end: 50,
        symbol_id: "sym:log",
        roles: 2,
      });
    }

    it("should include both import and semantic edges", () => {
      seedHybridData();
      const result = moduleGraph.getGraph(undefined, "hybrid");
      const kinds = result.edges.map((e) => e.kind);
      // At minimum we expect import-only, semantic-only, and combined edges
      expect(kinds.some((k) => k === "import" || k === "import+semantic")).toBe(true);
      expect(kinds.some((k) => k === "semantic" || k === "import+semantic")).toBe(true);
    });

    it("should tag overlapping edges as 'import+semantic'", () => {
      seedHybridData();
      const result = moduleGraph.getGraph(undefined, "hybrid");
      // src/index.ts → src/math.ts is both a structural import and a semantic reference
      const overlap = result.edges.find(
        (e) => e.from === "src/index.ts" && e.to === "src/math.ts",
      );
      expect(overlap).toBeDefined();
      expect(overlap!.kind).toBe("import+semantic");
    });

    it("should tag import-only edges as 'import'", () => {
      seedHybridData();
      const result = moduleGraph.getGraph(undefined, "hybrid");
      // src/index.ts → src/utils/helpers.ts is a structural import with no semantic edge
      const importOnly = result.edges.find(
        (e) => e.from === "src/index.ts" && e.to === "src/utils/helpers.ts",
      );
      expect(importOnly).toBeDefined();
      expect(importOnly!.kind).toBe("import");
    });

    it("should tag semantic-only edges as 'semantic'", () => {
      seedHybridData();
      const result = moduleGraph.getGraph(undefined, "hybrid");
      // src/math.ts → src/utils/helpers.ts is purely semantic (no structural import edge)
      const semanticOnly = result.edges.find(
        (e) => e.from === "src/math.ts" && e.to === "src/utils/helpers.ts",
      );
      expect(semanticOnly).toBeDefined();
      expect(semanticOnly!.kind).toBe("semantic");
    });

    it("should carry weight on edges that have a semantic component", () => {
      seedHybridData();
      const result = moduleGraph.getGraph(undefined, "hybrid");
      // All edges with a semantic component must have a weight field
      for (const edge of result.edges) {
        if (edge.kind === "semantic" || edge.kind === "import+semantic") {
          expect(edge.weight).toBeTypeOf("number");
          expect(edge.weight).toBeGreaterThan(0);
        }
      }
    });
  });

  // ── Symbol graph ─────────────────────────────────────────────────────

  describe("getSymbolGraph", () => {
    /**
     * Seed a symbol "sym:compute" defined in src/math.ts and referenced
     * in src/index.ts and src/utils/helpers.ts.
     */
    function seedSymbolData(): void {
      store.upsertSymbol({
        id: "sym:compute",
        kind: "function",
        name: "compute",
        file_path: "src/math.ts",
        range_start: 0,
        range_end: 40,
      });
      // Definition occurrence
      store.upsertOccurrence({
        file_path: "src/math.ts",
        range_start: 0,
        range_end: 40,
        symbol_id: "sym:compute",
        roles: 1,
      });
      // Reference in src/index.ts
      store.upsertOccurrence({
        file_path: "src/index.ts",
        range_start: 10,
        range_end: 20,
        symbol_id: "sym:compute",
        roles: 2,
      });
      // Reference in src/utils/helpers.ts
      store.upsertOccurrence({
        file_path: "src/utils/helpers.ts",
        range_start: 5,
        range_end: 15,
        symbol_id: "sym:compute",
        roles: 2,
      });
    }

    it("should return the definition file and all referencing files as nodes", () => {
      seedSymbolData();
      const result = moduleGraph.getSymbolGraph("sym:compute");
      const paths = result.nodes.map((n) => n.path);
      expect(paths).toContain("src/math.ts");
      expect(paths).toContain("src/index.ts");
      expect(paths).toContain("src/utils/helpers.ts");
    });

    it("should create edges from referencing files to the definition file", () => {
      seedSymbolData();
      const result = moduleGraph.getSymbolGraph("sym:compute");
      // Every edge should point to the definition file
      for (const edge of result.edges) {
        expect(edge.to).toBe("src/math.ts");
        expect(edge.kind).toBe("references");
      }
    });

    it("should not create a self-edge from the definition file to itself", () => {
      seedSymbolData();
      const result = moduleGraph.getSymbolGraph("sym:compute");
      const selfEdge = result.edges.find((e) => e.from === "src/math.ts");
      expect(selfEdge).toBeUndefined();
    });

    it("should cap the number of nodes via maxNodes", () => {
      seedSymbolData();
      // With maxNodes=1 only the definition file should appear (it is added first)
      const result = moduleGraph.getSymbolGraph("sym:compute", 1);
      expect(result.nodes).toHaveLength(1);
    });

    it("should return nodes even when the symbol has no definition file", () => {
      // Symbol exists in occurrences but has no file_path on the symbols row
      store.upsertSymbol({
        id: "sym:orphan",
        kind: "variable",
        name: "orphan",
        // file_path deliberately omitted
      });
      store.upsertOccurrence({
        file_path: "src/index.ts",
        range_start: 0,
        range_end: 5,
        symbol_id: "sym:orphan",
        roles: 2,
      });

      const result = moduleGraph.getSymbolGraph("sym:orphan");
      const paths = result.nodes.map((n) => n.path);
      expect(paths).toContain("src/index.ts");
      // No edges because there is no definition file
      expect(result.edges).toHaveLength(0);
    });

    it("should return empty graph for an unknown symbol", () => {
      const result = moduleGraph.getSymbolGraph("sym:does-not-exist");
      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });
  });

  // ── Export formats ───────────────────────────────────────────────────

  describe("toDot", () => {
    it("should produce output that starts with 'digraph module_graph {'", () => {
      const result = moduleGraph.getGraph();
      const dot = moduleGraph.toDot(result);
      expect(dot).toMatch(/^digraph module_graph \{/);
    });

    it("should include 'rankdir=LR;' and node style directive", () => {
      const result = moduleGraph.getGraph();
      const dot = moduleGraph.toDot(result);
      expect(dot).toContain("rankdir=LR;");
      expect(dot).toContain("node [shape=box, style=rounded]");
    });

    it("should quote all node paths", () => {
      const result = moduleGraph.getGraph();
      const dot = moduleGraph.toDot(result);
      expect(dot).toContain('"src/index.ts"');
      expect(dot).toContain('"src/math.ts"');
      expect(dot).toContain('"src/utils/helpers.ts"');
    });

    it("should include directed edges with label attribute", () => {
      const result = moduleGraph.getGraph();
      const dot = moduleGraph.toDot(result);
      expect(dot).toMatch(/"src\/index\.ts" -> "src\/math\.ts" \[label="imports"\]/);
      expect(dot).toMatch(
        /"src\/index\.ts" -> "src\/utils\/helpers\.ts" \[label="imports"\]/,
      );
    });

    it("should include weight attribute when edge has a weight", () => {
      // Add semantic occurrence data to get a weighted edge
      store.upsertSymbol({
        id: "sym:add",
        kind: "function",
        name: "add",
        file_path: "src/math.ts",
        range_start: 0,
        range_end: 30,
      });
      store.upsertOccurrence({
        file_path: "src/math.ts",
        range_start: 0,
        range_end: 30,
        symbol_id: "sym:add",
        roles: 1,
      });
      store.upsertOccurrence({
        file_path: "src/index.ts",
        range_start: 5,
        range_end: 15,
        symbol_id: "sym:add",
        roles: 2,
      });

      const result = moduleGraph.getGraph(undefined, "semantic");
      const dot = moduleGraph.toDot(result);
      expect(dot).toContain("weight=1");
    });

    it("should close the digraph with a closing brace", () => {
      const result = moduleGraph.getGraph();
      const dot = moduleGraph.toDot(result);
      expect(dot.trimEnd()).toMatch(/\}$/);
    });

    it("should produce a valid empty graph for an empty node set", () => {
      const empty = moduleGraph.getGraph("nonexistent/");
      const dot = moduleGraph.toDot(empty);
      expect(dot).toContain("digraph module_graph {");
      expect(dot).toContain("}");
      // No node or edge lines beyond the preamble
      const lines = dot.split("\n").filter((l) => l.trim() && !l.includes("{") && !l.trim().startsWith("}") && !l.includes("rankdir") && !l.includes("node ["));
      expect(lines).toHaveLength(0);
    });
  });

  describe("toMermaid", () => {
    it("should start with 'graph LR'", () => {
      const result = moduleGraph.getGraph();
      const mermaid = moduleGraph.toMermaid(result);
      expect(mermaid).toMatch(/^graph LR/);
    });

    it("should define nodes with sanitised IDs and quoted labels", () => {
      const result = moduleGraph.getGraph();
      const mermaid = moduleGraph.toMermaid(result);
      // Slashes, dots, and dashes are replaced with underscores in the ID
      expect(mermaid).toContain('src_index_ts["src/index.ts"]');
      expect(mermaid).toContain('src_math_ts["src/math.ts"]');
      expect(mermaid).toContain('src_utils_helpers_ts["src/utils/helpers.ts"]');
    });

    it("should emit directed edges using sanitised IDs with |kind| label", () => {
      const result = moduleGraph.getGraph();
      const mermaid = moduleGraph.toMermaid(result);
      expect(mermaid).toContain("src_index_ts -->|imports| src_math_ts");
      expect(mermaid).toContain("src_index_ts -->|imports| src_utils_helpers_ts");
    });

    it("should produce valid output for an empty graph", () => {
      const empty = moduleGraph.getGraph("nonexistent/");
      const mermaid = moduleGraph.toMermaid(empty);
      expect(mermaid).toBe("graph LR");
    });

    it("should sanitise hyphens in node paths", () => {
      store.upsertFile({ path: "src/my-module.ts", language: "typescript", hash: "h4" });
      const result = moduleGraph.getGraph("src/my-module.ts");
      const mermaid = moduleGraph.toMermaid(result);
      // Hyphens become underscores in the sanitised ID
      expect(mermaid).toContain('src_my_module_ts["src/my-module.ts"]');
    });
  });
});
