import { ContextCompiler } from "ariadne-core";
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

export async function runContext(args: string[]): Promise<void> {
  const rootArg = extractFlag(args, "--root");
  const depthRaw = extractFlag(args, "--depth");
  const budgetRaw = extractFlag(args, "--budget");
  const includeTests = hasFlag(args, "--include-tests");

  // Collect positional file paths (skip flags and their values)
  const skipNext = new Set<number>();
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (skipNext.has(i)) continue;
    if (args[i] === "--root" || args[i] === "--depth" || args[i] === "--budget") {
      skipNext.add(i + 1);
      continue;
    }
    if (args[i] === "--include-tests") continue;
    files.push(args[i]);
  }

  if (files.length === 0) {
    outputError(
      "MISSING_ARGUMENT",
      "Usage: ariadne context <file> [<file2>...] [--depth N] [--budget N] [--include-tests] [--root <path>]",
    );
  }

  const ctx = getContext(rootArg);
  try {
    const compiler = new ContextCompiler(ctx.store, ctx.repoRoot);
    const result = compiler.compile(files, {
      depth: depthRaw ? parseInt(depthRaw, 10) : undefined,
      budget: budgetRaw ? parseInt(budgetRaw, 10) : undefined,
      includeTests,
    });
    output("context", result);
  } finally {
    ctx.db.close();
  }
}
