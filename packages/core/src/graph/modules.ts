import type { StoreQueries } from "../store/queries";

// ── Result types ──────────────────────────────────────────────────────

export interface ModuleGraphResult {
  nodes: { path: string; language: string }[];
  edges: { from: string; to: string; kind: string }[];
}

// ── ModuleGraph ───────────────────────────────────────────────────────

export class ModuleGraph {
  constructor(private store: StoreQueries) {}

  /**
   * Build a module dependency graph.
   * Optionally scoped to files whose path starts with `scopePath`
   * (or matches it exactly).
   */
  getGraph(scopePath?: string): ModuleGraphResult {
    const files = this.store.getAllFiles();

    const nodes = files
      .filter(
        (f) =>
          !scopePath || f.path.startsWith(scopePath) || f.path === scopePath,
      )
      .map((f) => ({ path: f.path, language: f.language }));

    const edges: ModuleGraphResult["edges"] = [];

    for (const node of nodes) {
      for (const edge of this.store.getEdgesBySource(node.path)) {
        if (edge.kind === "imports" || edge.kind === "exports") {
          edges.push({ from: node.path, to: edge.target, kind: edge.kind });
        }
      }
    }

    return { nodes, edges };
  }
}
