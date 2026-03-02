import { ScopeAnalyzer } from "ariadne-core";
import { getContext } from "../lib/context";
import { output, outputError } from "../lib/output";

function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

/**
 * Scope command — compute ranked, token-budgeted context for an agent task.
 *
 * Usage:
 *   ariadne scope <file1> [file2] ... [--budget N] [--depth N] [--root <path>]
 *
 * Returns a tiered context (must-have / should-have / nice-to-have)
 * optimized for injection into an LLM context window.
 */
export function runScope(args: string[]): void {
  const rootArg = extractFlag(args, "--root");
  const budgetRaw = extractFlag(args, "--budget");
  const depthRaw = extractFlag(args, "--depth");

  // Collect file arguments (everything that's not a flag)
  const flagsWithValues = new Set(["--root", "--budget", "--depth"]);
  const skipNext = new Set<number>();
  for (const flag of flagsWithValues) {
    const idx = args.indexOf(flag);
    if (idx !== -1) {
      skipNext.add(idx);
      skipNext.add(idx + 1);
    }
  }
  const files = args.filter((a, i) => !a.startsWith("--") && !skipNext.has(i));

  if (files.length === 0) {
    outputError(
      "MISSING_ARGUMENT",
      "Usage: ariadne scope <file1> [file2] ... [--budget N] [--depth N] [--root <path>]",
    );
  }

  const ctx = getContext(rootArg);
  try {
    const analyzer = new ScopeAnalyzer(ctx.store, ctx.repoRoot);
    const result = analyzer.scope(files, {
      budget: budgetRaw ? parseInt(budgetRaw, 10) : undefined,
      depth: depthRaw ? parseInt(depthRaw, 10) : undefined,
    });

    // Strip full content from JSON output (too large), keep metadata
    const compact = {
      ...result,
      files: result.files.map((f) => ({
        path: f.path,
        tier: f.tier,
        depth: f.depth,
        reason: f.reason,
        symbolCount: f.symbols.length,
        symbols: f.symbols.map((s) => ({
          name: s.name,
          kind: s.kind,
          isExported: s.isExported,
        })),
        tokenEstimate: f.tokenEstimate,
      })),
    };

    output("scope", compact);
  } finally {
    ctx.db.close();
  }
}
