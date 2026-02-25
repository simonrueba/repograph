#!/usr/bin/env bun
/**
 * RepoGraph MCP Server
 *
 * Exposes the core RepoGraph index as 6 MCP tools that any
 * MCP-compatible client (Claude Code, Cursor, etc.) can call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";

// Import directly from core source files because the core barrel export
// (repograph-core/src/index.ts) may not be fully wired yet.
import { createDatabase } from "repograph-core/src/store/db";
import { StoreQueries } from "repograph-core/src/store/queries";
import { GraphQueries } from "repograph-core/src/graph/refs";
import { ImpactAnalyzer } from "repograph-core/src/graph/impact";
import { ModuleGraph } from "repograph-core/src/graph/modules";

// ── Bootstrap core services ──────────────────────────────────────────

const repoRoot = process.env.REPOGRAPH_ROOT || process.cwd();
const dbPath = join(repoRoot, ".repograph", "index.db");

const db = createDatabase(dbPath);
const store = new StoreQueries(db);
const graph = new GraphQueries(store, repoRoot);
const impact = new ImpactAnalyzer(store, repoRoot);
const modules = new ModuleGraph(store);

// ── MCP Server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: "repograph",
  version: "0.1.0",
});

// Tool 1: repograph.search_symbol
// Fuzzy-search symbols by name, returning at most `k` results.
server.tool(
  "repograph.search_symbol",
  "Search symbols by name (fuzzy LIKE match). Returns id, name, kind, file path, and range.",
  {
    query: z.string().describe("Substring to match against symbol names"),
    k: z.number().optional().describe("Maximum number of results to return (default 10)"),
  },
  async ({ query, k }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(graph.searchSymbol(query, k ?? 10)),
      },
    ],
  }),
);

// Tool 2: repograph.get_def
// Get full definition for a symbol including doc-string and code snippet.
server.tool(
  "repograph.get_def",
  "Get a symbol's definition by ID, including documentation and a code snippet.",
  {
    symbolId: z.string().describe("The unique symbol identifier (SCIP-style)"),
  },
  async ({ symbolId }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(graph.getDef(symbolId)),
      },
    ],
  }),
);

// Tool 3: repograph.find_refs
// Find all references (occurrences) of a symbol across the codebase.
server.tool(
  "repograph.find_refs",
  "Find all references to a symbol. Optionally scope to files under a given path prefix.",
  {
    symbolId: z.string().describe("The unique symbol identifier"),
    scope: z
      .string()
      .optional()
      .describe("Optional path prefix to restrict results (e.g. 'src/components/')"),
  },
  async ({ symbolId, scope }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(graph.findRefs(symbolId, { scope })),
      },
    ],
  }),
);

// Tool 4: repograph.impact
// Compute the blast radius of a set of changed files.
server.tool(
  "repograph.impact",
  "Compute the impact (blast radius) of changed files: affected symbols, dependent files, and recommended tests.",
  {
    paths: z
      .array(z.string())
      .describe("Array of changed file paths relative to repo root"),
  },
  async ({ paths }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(impact.computeImpact(paths)),
      },
    ],
  }),
);

// Tool 5: repograph.module_graph
// Get the file-level module dependency graph.
server.tool(
  "repograph.module_graph",
  "Get the module/file dependency graph. Optionally scope to a directory subtree.",
  {
    path: z
      .string()
      .optional()
      .describe("Optional path prefix to scope the graph (e.g. 'packages/core/')"),
  },
  async ({ path }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(modules.getGraph(path)),
      },
    ],
  }),
);

// Tool 6: repograph.status
// Get a summary of the current index state.
server.tool(
  "repograph.status",
  "Get the current index status: total files, total symbols, and last indexed timestamp.",
  {},
  async () => {
    const files = store.getAllFiles();
    const row = db
      .query("SELECT COUNT(*) as count FROM symbols")
      .get() as { count: number };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            totalFiles: files.length,
            totalSymbols: row.count,
            lastIndexed: files.reduce(
              (max, f) => Math.max(max, f.indexed_at ?? 0),
              0,
            ),
          }),
        },
      ],
    };
  },
);

// ── Start server ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
