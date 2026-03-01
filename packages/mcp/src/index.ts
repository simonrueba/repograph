#!/usr/bin/env bun
/**
 * Ariadne MCP Server
 *
 * Exposes the core Ariadne index as read-only MCP tools that any
 * MCP-compatible client (Claude Code, Cursor, etc.) can call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";

import { existsSync, mkdirSync, readFileSync } from "node:fs";

import {
  createDatabase,
  StoreQueries,
  GraphQueries,
  ImpactAnalyzer,
  ModuleGraph,
  StructuralMetrics,
  ContextCompiler,
  PreflightAnalyzer,
  type ModuleGraphResult,
} from "ariadne-core";

// ── Bootstrap core services ──────────────────────────────────────────

const repoRoot = process.env.ARIADNE_ROOT || process.cwd();
const ariadneDir = join(repoRoot, ".ariadne");
const dbPath = join(ariadneDir, "index.db");

// Ensure .ariadne/ exists — create if missing so the MCP server
// can start even before `ariadne init` has been run.
if (!existsSync(ariadneDir)) {
  mkdirSync(ariadneDir, { recursive: true });
  console.error("Ariadne: created .ariadne/ directory. Run 'ariadne setup' for a full index.");
}

const db = createDatabase(dbPath);
const store = new StoreQueries(db);
const graph = new GraphQueries(store, repoRoot);
const impact = new ImpactAnalyzer(store, repoRoot);
const modules = new ModuleGraph(store);
const metrics = new StructuralMetrics(store, repoRoot);
const contextCompiler = new ContextCompiler(store, repoRoot);
const preflight = new PreflightAnalyzer(store, repoRoot);

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

const pkgJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"));

const server = new McpServer({
  name: "ariadne",
  version: pkgJson.version as string,
});

// Tool 1: search_symbol
server.registerTool(
  "ariadne.search_symbol",
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
  "ariadne.get_def",
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
  "ariadne.find_refs",
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
  "ariadne.impact",
  {
    title: "Impact Analysis",
    description: "Compute the impact (blast radius) of changed files: affected symbols, dependent files, and recommended tests.",
    inputSchema: {
      paths: z
        .array(z.string())
        .describe("Array of changed file paths relative to repo root"),
      details: z
        .boolean()
        .optional()
        .describe("When true, include symbol definitions, docs, and key reference snippets"),
    },
    annotations: READ_ONLY,
  },
  async ({ paths, details }) => {
    try {
      return ok(
        details
          ? impact.computeDetailedImpact(paths)
          : impact.computeImpact(paths),
      );
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 5: module_graph
server.registerTool(
  "ariadne.module_graph",
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
  "ariadne.symbol_graph",
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
  "ariadne.file_symbols",
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
  "ariadne.status",
  {
    title: "Index Status",
    description: "Get the current index status: total files, total symbols, dirty count, and timestamps.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return ok({
        totalFiles: store.getFileCount(),
        totalSymbols: store.getSymbolCount(),
        dirtyCount: store.getDirtyCount(),
        lastIndexed: store.getLastIndexedAt(),
      });
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 9: call_graph
server.registerTool(
  "ariadne.call_graph",
  {
    title: "Call Graph",
    description: "Get the approximate call graph for a symbol: which functions call it (callers) and which functions it calls (callees).",
    inputSchema: {
      symbolId: z.string().describe("The symbol ID (SCIP-style identifier)"),
      depth: z.number().optional().describe("How many levels to traverse (default 1)"),
    },
    annotations: READ_ONLY,
  },
  async ({ symbolId, depth }) => {
    try {
      return ok(graph.getCallGraph(symbolId, depth ?? 1));
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 10: transitive_impact
server.registerTool(
  "ariadne.transitive_impact",
  {
    title: "Transitive Impact Analysis",
    description: "Compute full transitive impact (blast radius) of changed files with risk scoring. Traverses symbol references across multiple depths to find all affected files, packages, public API breaks, and relevant tests.",
    inputSchema: {
      paths: z
        .array(z.string())
        .describe("Array of changed file paths relative to repo root"),
      maxDepth: z
        .number()
        .optional()
        .describe("Maximum BFS depth for transitive traversal (default 5)"),
      includeCallGraph: z
        .boolean()
        .optional()
        .describe("When true, also traverse call graph edges (callers of changed symbols)"),
    },
    annotations: READ_ONLY,
  },
  async ({ paths, maxDepth, includeCallGraph }) => {
    try {
      return ok(
        impact.computeTransitiveImpact(paths, {
          maxDepth: maxDepth ?? undefined,
          includeCallGraph: includeCallGraph ?? false,
        }),
      );
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 11: metrics
server.registerTool(
  "ariadne.metrics",
  {
    title: "Structural Metrics",
    description: "Compute current structural metrics: module coupling (Ca/Ce/instability), dependency cycles, and public API surface per package.",
    inputSchema: {
      scopePath: z
        .string()
        .optional()
        .describe("Optional path prefix to scope coupling and cycle detection"),
    },
    annotations: READ_ONLY,
  },
  async ({ scopePath }) => {
    try {
      return ok(metrics.computeMetrics(scopePath ?? undefined));
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 12: cycles
server.registerTool(
  "ariadne.cycles",
  {
    title: "Cycle Detection",
    description: "Detect dependency cycles in the module graph using Tarjan's SCC algorithm. Returns all cycles with their members and sizes.",
    inputSchema: {
      scopePath: z
        .string()
        .optional()
        .describe("Optional path prefix to scope cycle detection"),
    },
    annotations: READ_ONLY,
  },
  async ({ scopePath }) => {
    try {
      return ok(metrics.detectCycles(scopePath ?? undefined));
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 13: plan_context
server.registerTool(
  "ariadne.plan_context",
  {
    title: "Context Compilation",
    description: "Compile dependency-aware context for entry files. BFS walks imports in both directions, scores files by relevance, and fills a token budget. Returns prioritized file contents for agent consumption.",
    inputSchema: {
      entries: z
        .array(z.string())
        .describe("Entry file paths relative to repo root"),
      depth: z
        .number()
        .optional()
        .describe("BFS depth limit (default 3)"),
      budget: z
        .number()
        .optional()
        .describe("Token budget (default 50000)"),
      includeTests: z
        .boolean()
        .optional()
        .describe("Include test files at normal priority (default false)"),
    },
    annotations: READ_ONLY,
  },
  async ({ entries, depth, budget, includeTests }) => {
    try {
      return ok(
        contextCompiler.compile(entries, {
          depth: depth ?? undefined,
          budget: budget ?? undefined,
          includeTests: includeTests ?? false,
        }),
      );
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// Tool 14: preflight
server.registerTool(
  "ariadne.preflight",
  {
    title: "Pre-Flight Analysis",
    description: "Semantic pre-flight analysis for a file about to be edited. Returns all symbols with call sites, signatures, blast radius, boundary info, and a prescriptive checklist of actions needed.",
    inputSchema: {
      path: z.string().describe("File path relative to repo root"),
      fast: z
        .boolean()
        .optional()
        .describe("Fast mode: skip transitive analysis, cap call sites to 5 (default false)"),
    },
    annotations: READ_ONLY,
  },
  async ({ path, fast }) => {
    try {
      return ok(preflight.analyze(path, { fast: fast ?? false }));
    } catch (e: unknown) {
      return err(toErrorMessage(e));
    }
  },
);

// ── Start server ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Ariadne MCP Server running on stdio");
