import { GraphQueries, ImpactAnalyzer, ModuleGraph } from "repograph-core";
import { getContext } from "../lib/context";

function extractRoot(args: string[]): string | undefined {
  const idx = args.indexOf("--root");
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function stripRootArgs(args: string[]): string[] {
  const idx = args.indexOf("--root");
  if (idx !== -1) {
    return [...args.slice(0, idx), ...args.slice(idx + 2)];
  }
  return args;
}

export async function runQuery(args: string[]): Promise<void> {
  const rootArg = extractRoot(args);
  const cleanArgs = stripRootArgs(args);
  const subcommand = cleanArgs[0];
  const ctx = getContext(rootArg);
  const graph = new GraphQueries(ctx.store, ctx.repoRoot);

  try {
    switch (subcommand) {
      case "search": {
        const query = cleanArgs[1];
        if (!query) {
          console.error("Usage: repograph query search <name> [--root <path>]");
          process.exit(1);
        }
        const k = parseInt(cleanArgs[2] || "10", 10);
        const results = graph.searchSymbol(query, k);
        console.log(JSON.stringify({ results }));
        break;
      }

      case "def": {
        const symbolId = cleanArgs[1];
        if (!symbolId) {
          console.error("Usage: repograph query def <symbol-id> [--root <path>]");
          process.exit(1);
        }
        const result = graph.getDef(symbolId);
        console.log(JSON.stringify({ result }));
        break;
      }

      case "refs": {
        const symbolId = cleanArgs[1];
        if (!symbolId) {
          console.error("Usage: repograph query refs <symbol-id> [--root <path>]");
          process.exit(1);
        }
        const results = graph.findRefs(symbolId);
        console.log(JSON.stringify({ results }));
        break;
      }

      case "impact": {
        const files = cleanArgs.slice(1).filter((a) => !a.startsWith("--"));
        if (files.length === 0) {
          console.error(
            "Usage: repograph query impact <file1> [file2] ... [--root <path>]",
          );
          process.exit(1);
        }
        const analyzer = new ImpactAnalyzer(ctx.store, ctx.repoRoot);
        const result = analyzer.computeImpact(files);
        console.log(JSON.stringify({ result }));
        break;
      }

      case "module-graph": {
        const scope = cleanArgs[1]; // optional scope path
        const moduleGraph = new ModuleGraph(ctx.store);
        const result = moduleGraph.getGraph(scope);
        console.log(JSON.stringify({ result }));
        break;
      }

      default:
        console.error(`Unknown query subcommand: ${subcommand}`);
        console.error(
          "Usage: repograph query <search|def|refs|impact|module-graph> [--root <path>]",
        );
        process.exit(1);
    }
  } finally {
    ctx.db.close();
  }
}
