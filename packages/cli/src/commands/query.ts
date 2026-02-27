import {
  GraphQueries,
  ImpactAnalyzer,
  ModuleGraph,
  type GraphMode,
  type ModuleGraphResult,
  type ImpactResult,
  type DetailedImpactResult,
} from "ariadne-core";
import { getContext } from "../lib/context";
import { output, outputError } from "../lib/output";

/**
 * Format impact result as hookSpecificOutput JSON for the pre-edit hook.
 * This replaces the bun -e formatting that previously ran in a subprocess.
 */
function formatImpactAsHook(result: ImpactResult | DetailedImpactResult, file: string): void {
  const symbols = result.changedSymbols || [];
  const deps = result.dependentFiles || [];
  const tests = result.recommendedTests || [];

  if (symbols.length === 0 && deps.length === 0 && tests.length === 0) {
    return;
  }

  const lines: string[] = [];
  lines.push("[Impact Analysis] Editing " + file);

  if (symbols.length > 0) {
    const names = [...new Set(symbols.map((s) => s.name))];
    lines.push(
      "  Symbols defined here: " +
        names.slice(0, 20).join(", ") +
        (names.length > 20 ? " (+" + (names.length - 20) + " more)" : ""),
    );
  }

  if (deps.length > 0) {
    const top = deps.slice(0, 10);
    lines.push(
      "  Dependent files (" +
        deps.length +
        "): " +
        top.map((d) => d.path).join(", ") +
        (deps.length > 10 ? " (+" + (deps.length - 10) + " more)" : ""),
    );
  }

  if (tests.length > 0) {
    lines.push("  Recommended tests: " + tests.map((t) => t.command).join(", "));
  }

  const detailed = result as DetailedImpactResult;

  if (detailed.symbolDetails?.length > 0) {
    const detailLines = detailed.symbolDetails.slice(0, 5).map((s) => {
      const kind = s.kind ? ` (${s.kind})` : "";
      const doc = s.doc ? " — " + s.doc.split("\n").slice(0, 2).join(" ") : "";
      return `    ${s.name}${kind}${doc}`;
    });
    lines.push("  Symbol details:");
    lines.push(...detailLines);
  }

  if (detailed.keyRefs?.length > 0) {
    const refLines = detailed.keyRefs.slice(0, 5).map(
      (kr) =>
        `    ${kr.symbolName} in ${kr.filePath}` +
        (kr.snippet ? `: ${kr.snippet.split("\n")[0]}` : ""),
    );
    lines.push("  Key references:");
    lines.push(...refLines);
  }

  const context = lines.join("\n");
  const hookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(hookOutput) + "\n");
}

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
          outputError("MISSING_ARGUMENT", "Usage: ariadne query search <name> [--root <path>]");
        }
        const k = parseInt(cleanArgs[2] || "10", 10);
        const results = graph.searchSymbol(query, k);
        output("query.search", { results });
        break;
      }

      case "def": {
        const symbolId = cleanArgs[1];
        if (!symbolId) {
          outputError("MISSING_ARGUMENT", "Usage: ariadne query def <symbol-id> [--root <path>]");
        }
        const result = graph.getDef(symbolId);
        output("query.def", { result });
        break;
      }

      case "refs": {
        const symbolId = cleanArgs[1];
        if (!symbolId) {
          outputError("MISSING_ARGUMENT", "Usage: ariadne query refs <symbol-id> [--root <path>]");
        }
        const results = graph.findRefs(symbolId);
        output("query.refs", { results });
        break;
      }

      case "impact": {
        const details = cleanArgs.includes("--details");
        const hookFormat = cleanArgs.includes("--format=hook");
        const files = cleanArgs.slice(1).filter((a) => !a.startsWith("--"));
        if (files.length === 0) {
          outputError(
            "MISSING_ARGUMENT",
            "Usage: ariadne query impact <file1> [file2] ... [--details] [--format=hook] [--root <path>]",
          );
        }
        const analyzer = new ImpactAnalyzer(ctx.store, ctx.repoRoot);
        const result = details
          ? analyzer.computeDetailedImpact(files)
          : analyzer.computeImpact(files);

        if (hookFormat) {
          formatImpactAsHook(result, files[0] ?? "file");
        } else {
          output("query.impact", { result });
        }
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
            "Usage: ariadne query symbol-graph <symbol-id> [--format json|dot|mermaid] [--max-nodes N] [--root <path>]",
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
            "Usage: ariadne query call-graph <symbol-id> [--depth N] [--root <path>]",
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
