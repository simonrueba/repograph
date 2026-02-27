import {
  GraphQueries,
  ImpactAnalyzer,
  ModuleGraph,
  type GraphMode,
  type ModuleGraphResult,
} from "repograph-core";
import { getContext } from "../lib/context";
import { output, outputError } from "../lib/output";

// ── Argument helpers ───────────────────────────────────────────────────

function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function stripFlag(args: string[], flag: string): string[] {
  const idx = args.indexOf(flag);
  if (idx !== -1) {
    return [...args.slice(0, idx), ...args.slice(idx + 2)];
  }
  return args;
}

function extractRoot(args: string[]): string | undefined {
  return extractFlag(args, "--root");
}

function stripRootArgs(args: string[]): string[] {
  return stripFlag(args, "--root");
}

// ── Output format helpers ─────────────────────────────────────────────

type OutputFormat = "json" | "dot" | "mermaid";

function resolveFormat(raw: string | undefined): OutputFormat {
  if (raw === "dot" || raw === "mermaid") return raw;
  return "json";
}

function resolveMode(raw: string | undefined): GraphMode {
  if (raw === "semantic" || raw === "hybrid") return raw;
  return "imports";
}

function emitGraph(
  result: ModuleGraphResult,
  format: OutputFormat,
  modules: ModuleGraph,
  outputKind: string,
): void {
  if (format === "dot") {
    process.stdout.write(modules.toDot(result) + "\n");
    return;
  }
  if (format === "mermaid") {
    process.stdout.write(modules.toMermaid(result) + "\n");
    return;
  }
  output(outputKind, { result });
}

// ── Main entry point ──────────────────────────────────────────────────

export async function runQuery(args: string[]): Promise<void> {
  const rootArg = extractRoot(args);
  let cleanArgs = stripRootArgs(args);
  const subcommand = cleanArgs[0];
  const ctx = getContext(rootArg);
  const graph = new GraphQueries(ctx.store, ctx.repoRoot);

  try {
    switch (subcommand) {
      case "search": {
        const query = cleanArgs[1];
        if (!query) {
          outputError("MISSING_ARGUMENT", "Usage: repograph query search <name> [--root <path>]");
        }
        const k = parseInt(cleanArgs[2] || "10", 10);
        const results = graph.searchSymbol(query, k);
        output("query.search", { results });
        break;
      }

      case "def": {
        const symbolId = cleanArgs[1];
        if (!symbolId) {
          outputError("MISSING_ARGUMENT", "Usage: repograph query def <symbol-id> [--root <path>]");
        }
        const result = graph.getDef(symbolId);
        output("query.def", { result });
        break;
      }

      case "refs": {
        const symbolId = cleanArgs[1];
        if (!symbolId) {
          outputError("MISSING_ARGUMENT", "Usage: repograph query refs <symbol-id> [--root <path>]");
        }
        const results = graph.findRefs(symbolId);
        output("query.refs", { results });
        break;
      }

      case "impact": {
        const details = cleanArgs.includes("--details");
        const files = cleanArgs.slice(1).filter((a) => !a.startsWith("--"));
        if (files.length === 0) {
          outputError(
            "MISSING_ARGUMENT",
            "Usage: repograph query impact <file1> [file2] ... [--details] [--root <path>]",
          );
        }
        const analyzer = new ImpactAnalyzer(ctx.store, ctx.repoRoot);
        const result = details
          ? analyzer.computeDetailedImpact(files)
          : analyzer.computeImpact(files);
        output("query.impact", { result });
        break;
      }

      case "module-graph": {
        // Strip --mode and --format before reading positional arg
        const modeRaw = extractFlag(cleanArgs, "--mode");
        const formatRaw = extractFlag(cleanArgs, "--format");
        cleanArgs = stripFlag(stripFlag(cleanArgs, "--mode"), "--format");

        // First positional after subcommand is the optional scope path
        const scope = cleanArgs[1]?.startsWith("--") ? undefined : cleanArgs[1];

        const mode = resolveMode(modeRaw);
        const format = resolveFormat(formatRaw);

        const modules = new ModuleGraph(ctx.store);
        const result = modules.getGraph(scope, mode);

        emitGraph(result, format, modules, "query.module-graph");
        break;
      }

      case "symbol-graph": {
        const maxNodesRaw = extractFlag(cleanArgs, "--max-nodes");
        const formatRaw = extractFlag(cleanArgs, "--format");
        cleanArgs = stripFlag(stripFlag(cleanArgs, "--max-nodes"), "--format");

        const symbolId = cleanArgs[1];
        if (!symbolId) {
          outputError(
            "MISSING_ARGUMENT",
            "Usage: repograph query symbol-graph <symbol-id> [--format json|dot|mermaid] [--max-nodes N] [--root <path>]",
          );
        }

        const maxNodes = maxNodesRaw ? parseInt(maxNodesRaw, 10) : undefined;
        const format = resolveFormat(formatRaw);

        const modules = new ModuleGraph(ctx.store);
        const result = modules.getSymbolGraph(symbolId, maxNodes);

        emitGraph(result, format, modules, "query.symbol-graph");
        break;
      }

      case "call-graph": {
        const depthRaw = extractFlag(cleanArgs, "--depth");
        cleanArgs = stripFlag(cleanArgs, "--depth");
        const symbolId = cleanArgs[1];
        if (!symbolId) {
          outputError(
            "MISSING_ARGUMENT",
            "Usage: repograph query call-graph <symbol-id> [--depth N] [--root <path>]",
          );
        }
        const depth = depthRaw ? parseInt(depthRaw, 10) : 1;
        const result = graph.getCallGraph(symbolId, depth);
        output("query.call-graph", { result });
        break;
      }

      default:
        outputError(
          "UNKNOWN_SUBCOMMAND",
          `Unknown query subcommand: ${subcommand}`,
        );
    }
  } finally {
    ctx.db.close();
  }
}
