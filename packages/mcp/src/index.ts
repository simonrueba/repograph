#!/usr/bin/env bun
/**
 * RepoGraph MCP Server
 *
 * Exposes the core RepoGraph index as read-only MCP tools that any
 * MCP-compatible client (Claude Code, Cursor, etc.) can call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";

import {
  createDatabase,
  StoreQueries,
  GraphQueries,
  ImpactAnalyzer,
  ModuleGraph,
  type ModuleGraphResult,
} from "repograph-core";

// ── Bootstrap core services ──────────────────────────────────────────

const repoRoot = process.env.REPOGRAPH_ROOT || process.cwd();
const dbPath = join(repoRoot, ".repograph", "index.db");

const db = createDatabase(dbPath);
const store = new StoreQueries(db);
const graph = new GraphQueries(store, repoRoot);
const impact = new ImpactAnalyzer(store, repoRoot);
const modules = new ModuleGraph(store);

// ── Helpers ──────────────────────────────────────────────────────────

const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── MCP Server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: "repograph",
  version: "0.1.0",
});

// Tool 1: search_symbol
server.registerTool(
  "repograph.search_symbol",
  {
    title: "Search Symbols",
    description: "Search symbols by name (fuzzy LIKE match). Returns id, name, kind, file path, and range.",
    inputSchema: {
      query: z.string().describe("Substring to match against symbol names"),
      k: z.number().optional().describe("Maximum number of results to return (default 10)"),
    },
    annotations: READ_ONLY,
  },
  async ({ query, k }) => {
    try {
      return ok(graph.searchSymbol(query, k ?? 10));
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 2: get_def
server.registerTool(
  "repograph.get_def",
  {
    title: "Get Definition",
    description: "Get a symbol's definition by ID, including documentation and a code snippet.",
    inputSchema: {
      symbolId: z.string().describe("The unique symbol identifier (SCIP-style)"),
    },
    annotations: READ_ONLY,
  },
  async ({ symbolId }) => {
    try {
      return ok(graph.getDef(symbolId));
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 3: find_refs
server.registerTool(
  "repograph.find_refs",
  {
    title: "Find References",
    description: "Find all references to a symbol. Optionally scope to files under a given path prefix.",
    inputSchema: {
      symbolId: z.string().describe("The unique symbol identifier"),
      scope: z
        .string()
        .optional()
        .describe("Optional path prefix to restrict results (e.g. 'src/components/')"),
    },
    annotations: READ_ONLY,
  },
  async ({ symbolId, scope }) => {
    try {
      return ok(graph.findRefs(symbolId, { scope }));
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 4: impact
server.registerTool(
  "repograph.impact",
  {
    title: "Impact Analysis",
    description: "Compute the impact (blast radius) of changed files: affected symbols, dependent files, and recommended tests.",
    inputSchema: {
      paths: z
        .array(z.string())
        .describe("Array of changed file paths relative to repo root"),
    },
    annotations: READ_ONLY,
  },
  async ({ paths }) => {
    try {
      return ok(impact.computeImpact(paths));
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 5: module_graph
server.registerTool(
  "repograph.module_graph",
  {
    title: "Module Graph",
    description: "Get the module/file dependency graph. Optionally scope to a directory subtree.",
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe("Optional path prefix to scope the graph (e.g. 'packages/core/')"),
      mode: z
        .enum(["imports", "semantic", "hybrid"])
        .optional()
        .describe(
          "Graph mode: 'imports' (structural import edges, default), 'semantic' (SCIP occurrence-derived edges with weights), or 'hybrid' (union of both).",
        ),
      format: z
        .enum(["json", "dot", "mermaid"])
        .optional()
        .describe("Output format: 'json' (default), 'dot' (Graphviz), or 'mermaid'."),
    },
    annotations: READ_ONLY,
  },
  async ({ path, mode, format }) => {
    try {
      const result = modules.getGraph(path, mode ?? "imports");
      let text: string;
      if (format === "dot") {
        text = modules.toDot(result);
      } else if (format === "mermaid") {
        text = modules.toMermaid(result);
      } else {
        text = JSON.stringify(result);
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 6: symbol_graph
server.registerTool(
  "repograph.symbol_graph",
  {
    title: "Symbol Graph",
    description: "Get the dependency subgraph centered on a specific symbol. Returns the symbol's definition file and all files that reference it.",
    inputSchema: {
      symbolId: z.string().describe("The symbol ID (SCIP-style identifier)"),
      maxNodes: z
        .number()
        .optional()
        .describe("Maximum number of nodes to include in the subgraph (default 50)"),
      format: z
        .enum(["json", "dot", "mermaid"])
        .optional()
        .describe("Output format: 'json' (default), 'dot' (Graphviz), or 'mermaid'."),
    },
    annotations: READ_ONLY,
  },
  async ({ symbolId, maxNodes, format }) => {
    try {
      const result: ModuleGraphResult = modules.getSymbolGraph(symbolId, maxNodes);
      let text: string;
      if (format === "dot") {
        text = modules.toDot(result);
      } else if (format === "mermaid") {
        text = modules.toMermaid(result);
      } else {
        text = JSON.stringify(result);
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 7: file_symbols
server.registerTool(
  "repograph.file_symbols",
  {
    title: "File Symbols",
    description: "List all symbols defined in a specific file.",
    inputSchema: {
      path: z.string().describe("File path relative to repo root"),
    },
    annotations: READ_ONLY,
  },
  async ({ path }) => {
    try {
      return ok(store.getSymbolsByFile(path));
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 8: status
server.registerTool(
  "repograph.status",
  {
    title: "Index Status",
    description: "Get the current index status: total files, total symbols, dirty count, and timestamps.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      const files = store.getAllFiles();
      const row = db
        .query("SELECT COUNT(*) as count FROM symbols")
        .get() as { count: number };

      return ok({
        totalFiles: files.length,
        totalSymbols: row.count,
        dirtyCount: store.getDirtyCount(),
        lastIndexed: files.reduce(
          (max, f) => Math.max(max, f.indexed_at ?? 0),
          0,
        ),
      });
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// ── Start server ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("RepoGraph MCP Server running on stdio");
