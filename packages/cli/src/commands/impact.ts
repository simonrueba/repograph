import { ImpactAnalyzer } from "ariadne-core";
import { getContext } from "../lib/context";
import { output, outputError } from "../lib/output";

function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export async function runImpact(args: string[]): Promise<void> {
  const rootArg = extractFlag(args, "--root");
  const maxDepthRaw = extractFlag(args, "--max-depth");
  const includeCallGraph = hasFlag(args, "--call-graph");

  // Collect file paths (positional args, skip flags and their values)
  const skipNext = new Set<number>();
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (skipNext.has(i)) continue;
    if (args[i] === "--root" || args[i] === "--max-depth") {
      skipNext.add(i + 1);
      continue;
    }
    if (args[i] === "--call-graph") continue;
    files.push(args[i]);
  }

  if (files.length === 0) {
    outputError(
      "MISSING_ARGUMENT",
      "Usage: ariadne impact <file1> [file2] [--max-depth N] [--call-graph] [--root <path>]",
    );
  }

  const ctx = getContext(rootArg);
  try {
    const analyzer = new ImpactAnalyzer(ctx.store, ctx.repoRoot);
    const result = analyzer.computeTransitiveImpact(files, {
      maxDepth: maxDepthRaw ? parseInt(maxDepthRaw, 10) : undefined,
      includeCallGraph,
    });
    output("transitive_impact", result);
  } finally {
    ctx.db.close();
  }
}
