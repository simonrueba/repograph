import type { StoreQueries } from "../store/queries";

// ── Result types ──────────────────────────────────────────────────────

export interface ModuleGraphResult {
  nodes: { path: string; language: string }[];
  edges: { from: string; to: string; kind: string; weight?: number }[];
}

/**
 * Controls how file-to-file edges are derived.
 *
 * - `"imports"` (default): uses the structural `edges` table (kind = imports/exports).
 * - `"semantic"`: derives edges from SCIP occurrence data — a reference to a symbol
 *   defined in another file creates a directed edge from the referencing file to the
 *   defining file.  Each edge carries a `weight` equal to the total number of
 *   reference occurrences from the source file to symbols defined in the target file.
 * - `"hybrid"`: union of both modes.  Each edge is tagged with its origin via `kind`:
 *   `"import"`, `"semantic"`, or `"import+semantic"`.
 */
export type GraphMode = "imports" | "semantic" | "hybrid";

/** Bit-mask value for the definition role in SCIP occurrence data. */
const DEFINITION_ROLE = 1;

// ── ModuleGraph ───────────────────────────────────────────────────────

export class ModuleGraph {
  constructor(private store: StoreQueries) {}

  // ── Core graph construction ────────────────────────────────────

  /**
   * Build a module dependency graph.
   *
   * @param scopePath - Optional path prefix.  Only files whose `path` starts with
   *   (or equals) this value are included.
   * @param mode - How edges are derived (default `"imports"`).
   */
  getGraph(scopePath?: string, mode: GraphMode = "imports"): ModuleGraphResult {
    const files = this.store.getAllFiles();

    const nodes = files
      .filter(
        (f) =>
          !scopePath || f.path.startsWith(scopePath) || f.path === scopePath,
      )
      .map((f) => ({ path: f.path, language: f.language }));

    const nodePathSet = new Set(nodes.map((n) => n.path));

    if (mode === "imports") {
      return { nodes, edges: this._importEdges(nodes, nodePathSet) };
    }

    if (mode === "semantic") {
      return { nodes, edges: this._semanticEdges(nodes, nodePathSet) };
    }

    // hybrid: union with source tagging
    return { nodes, edges: this._hybridEdges(nodes, nodePathSet) };
  }

  // ── Symbol subgraph ────────────────────────────────────────────

  /**
   * Return a subgraph centred on a single symbol.
   *
   * The subgraph includes the symbol's definition file and all files that
   * reference it.  Edges run from each referencing file to the definition file
   * with `kind = "references"`.
   *
   * @param symbolId - SCIP-style symbol identifier.
   * @param maxNodes - Upper bound on the number of nodes returned (default 50).
   */
  getSymbolGraph(symbolId: string, maxNodes = 50): ModuleGraphResult {
    const symbol = this.store.getSymbol(symbolId);
    const defFilePath = symbol?.file_path ?? null;

    // Collect all files that contain an occurrence of this symbol
    const occurrences = this.store.getOccurrencesBySymbol(symbolId);

    // Deduplicate file paths and cap at maxNodes
    const filePathSet = new Set<string>();
    if (defFilePath) filePathSet.add(defFilePath);

    for (const occ of occurrences) {
      if (filePathSet.size >= maxNodes) break;
      filePathSet.add(occ.file_path);
    }

    // Build node list — fetch language per file instead of loading all files
    const nodes: ModuleGraphResult["nodes"] = [];
    for (const p of filePathSet) {
      const info = this.store.getFile(p);
      nodes.push({ path: p, language: info?.language ?? "unknown" });
    }

    // Edges: referencing file → definition file, kind "references"
    const edges: ModuleGraphResult["edges"] = [];
    if (defFilePath) {
      for (const { path: nodePath } of nodes) {
        if (nodePath !== defFilePath) {
          edges.push({ from: nodePath, to: defFilePath, kind: "references" });
        }
      }
    }

    return { nodes, edges };
  }

  // ── Export helpers ─────────────────────────────────────────────

  /**
   * Serialise a graph result to Graphviz DOT format.
   *
   * ```dot
   * digraph module_graph {
   *   rankdir=LR;
   *   node [shape=box, style=rounded];
   *   "src/a.ts";
   *   "src/b.ts";
   *   "src/b.ts" -> "src/a.ts" [label="imports"];
   * }
   * ```
   */
  toDot(result: ModuleGraphResult): string {
    const lines: string[] = [
      "digraph module_graph {",
      "  rankdir=LR;",
      '  node [shape=box, style=rounded];',
    ];

    for (const node of result.nodes) {
      lines.push(`  ${JSON.stringify(node.path)};`);
    }

    for (const edge of result.edges) {
      const attrs: string[] = [`label=${JSON.stringify(edge.kind)}`];
      if (edge.weight !== undefined) {
        attrs.push(`weight=${edge.weight}`);
      }
      lines.push(
        `  ${JSON.stringify(edge.from)} -> ${JSON.stringify(edge.to)} [${attrs.join(", ")}];`,
      );
    }

    lines.push("}");
    return lines.join("\n");
  }

  /**
   * Serialise a graph result to Mermaid flowchart syntax.
   *
   * Node IDs are sanitised by replacing `/`, `.`, and `-` with `_`.
   *
   * ```mermaid
   * graph LR
   *   src_a_ts["src/a.ts"]
   *   src_b_ts["src/b.ts"]
   *   src_b_ts -->|imports| src_a_ts
   * ```
   */
  toMermaid(result: ModuleGraphResult): string {
    const sanitize = (p: string): string =>
      p.replace(/[/.\-]/g, "_");

    const lines: string[] = ["graph LR"];

    for (const node of result.nodes) {
      const id = sanitize(node.path);
      lines.push(`  ${id}[${JSON.stringify(node.path)}]`);
    }

    for (const edge of result.edges) {
      const fromId = sanitize(edge.from);
      const toId = sanitize(edge.to);
      lines.push(`  ${fromId} -->|${edge.kind}| ${toId}`);
    }

    return lines.join("\n");
  }

  // ── Private helpers ────────────────────────────────────────────

  private _importEdges(
    nodes: ModuleGraphResult["nodes"],
    _nodePathSet: Set<string>,
  ): ModuleGraphResult["edges"] {
    const edges: ModuleGraphResult["edges"] = [];
    for (const node of nodes) {
      for (const edge of this.store.getEdgesBySource(node.path)) {
        if (edge.kind === "imports" || edge.kind === "exports") {
          edges.push({ from: node.path, to: edge.target, kind: edge.kind });
        }
      }
    }
    return edges;
  }

  private _semanticEdges(
    nodes: ModuleGraphResult["nodes"],
    nodePathSet: Set<string>,
  ): ModuleGraphResult["edges"] {
    // Pre-load symbol → file_path map to avoid per-occurrence DB lookups
    const symbolFileMap = this.store.getSymbolFileMap();

    // weight map: "fromPath\0toPath" → total reference occurrence count
    const weightMap = new Map<string, number>();

    for (const node of nodes) {
      const occurrences = this.store.getOccurrencesByFile(node.path);

      for (const occ of occurrences) {
        // Skip definition occurrences — we want references
        if (occ.roles & DEFINITION_ROLE) continue;

        const defFile = symbolFileMap.get(occ.symbol_id);
        if (!defFile) continue;
        if (defFile === node.path) continue;

        // Only emit edges to files that are in scope (in nodePathSet)
        if (!nodePathSet.has(defFile)) continue;

        const key = `${node.path}\0${defFile}`;
        weightMap.set(key, (weightMap.get(key) ?? 0) + 1);
      }
    }

    return Array.from(weightMap.entries()).map(([key, weight]) => {
      const sep = key.indexOf("\0");
      return {
        from: key.slice(0, sep),
        to: key.slice(sep + 1),
        kind: "semantic",
        weight,
      };
    });
  }

  private _hybridEdges(
    nodes: ModuleGraphResult["nodes"],
    nodePathSet: Set<string>,
  ): ModuleGraphResult["edges"] {
    // Collect import edges
    const importSet = new Map<string, { from: string; to: string; kind: string }>();
    for (const edge of this._importEdges(nodes, nodePathSet)) {
      const key = `${edge.from}\0${edge.to}`;
      importSet.set(key, edge);
    }

    // Collect semantic edges
    const semanticMap = new Map<string, number>();
    for (const edge of this._semanticEdges(nodes, nodePathSet)) {
      const key = `${edge.from}\0${edge.to}`;
      semanticMap.set(key, edge.weight ?? 1);
    }

    // Union
    const result: ModuleGraphResult["edges"] = [];
    const allKeys = new Set([...importSet.keys(), ...semanticMap.keys()]);

    for (const key of allKeys) {
      const hasImport = importSet.has(key);
      const semanticWeight = semanticMap.get(key);
      const hasSemantic = semanticWeight !== undefined;

      const sep = key.indexOf("\0");
      const from = key.slice(0, sep);
      const to = key.slice(sep + 1);

      let kind: string;
      if (hasImport && hasSemantic) {
        kind = "import+semantic";
      } else if (hasImport) {
        kind = "import";
      } else {
        kind = "semantic";
      }

      const edge: ModuleGraphResult["edges"][number] = { from, to, kind };
      if (hasSemantic) {
        edge.weight = semanticWeight;
      }

      result.push(edge);
    }

    return result;
  }
}
