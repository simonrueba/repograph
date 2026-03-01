import { PreflightAnalyzer } from "ariadne-core";
import { getContext } from "../lib/context";
import { output, outputError } from "../lib/output";
import type { PreflightResult } from "ariadne-core";

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

function formatPreflightAsHook(result: PreflightResult): void {
  if (result.symbols.length === 0) return;

  const lines: string[] = [];
  lines.push(`[Pre-Flight] ${result.file}`);

  // Blast radius warning
  const br = result.blastRadius;
  if (br.directDependents > 0) {
    lines.push(
      `  ⚠ Blast radius: ${br.directDependents} direct dependent${br.directDependents > 1 ? "s" : ""} (${br.riskCategory})`,
    );
  }

  // Top-level symbols with call sites (skip interface/type members like "id", "name")
  const TOP_LEVEL_KINDS = new Set([
    "function", "method", "class", "interface", "type", "type_alias",
    "enum", "module", "namespace", "constant", "object",
  ]);
  const topSymbols = result.symbols
    .filter((s) => s.callSites.length > 0 && TOP_LEVEL_KINDS.has(s.kind))
    .slice(0, 10);

  for (const sym of topSymbols) {
    lines.push(`  ${sym.kind} ${sym.name}: ${sym.callSites.length} call site${sym.callSites.length > 1 ? "s" : ""}`);
    for (const cs of sym.callSites.slice(0, 3)) {
      lines.push(`    ${cs.file}:${cs.line}: ${cs.snippet}`);
    }
    if (sym.callSites.length > 3) {
      lines.push(`    (+${sym.callSites.length - 3} more)`);
    }
  }

  // Compact checklist: only the most important items
  const importantChecklist = result.checklist.filter(
    (c) => c.startsWith("Run tests") || c.startsWith("Warning") || c.startsWith("Boundary"),
  );
  // Add top-level symbol change warnings (skip member fields)
  const topNames = new Set(topSymbols.map((s) => s.name));
  const symbolChecklist = result.checklist.filter(
    (c) => c.startsWith("If you change") && [...topNames].some((n) => c.includes(`'${n}'`)),
  );

  const checklist = [...symbolChecklist.slice(0, 5), ...importantChecklist];
  if (checklist.length > 0) {
    lines.push("  Checklist:");
    for (const item of checklist) {
      lines.push(`    - ${item}`);
    }
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

export async function runPreflight(args: string[]): Promise<void> {
  const rootArg = extractFlag(args, "--root");
  const fast = hasFlag(args, "--fast");
  const hookFormat = hasFlag(args, "--format=hook") || args.includes("--format=hook");

  // Collect positional file path
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") { i++; continue; }
    if (args[i].startsWith("--")) continue;
    files.push(args[i]);
  }

  if (files.length === 0) {
    outputError(
      "MISSING_ARGUMENT",
      "Usage: ariadne preflight <file> [--fast] [--format hook|json] [--root <path>]",
    );
  }

  const ctx = getContext(rootArg);
  try {
    const analyzer = new PreflightAnalyzer(ctx.store, ctx.repoRoot);
    const result = analyzer.analyze(files[0], { fast });

    if (hookFormat) {
      formatPreflightAsHook(result);
    } else {
      output("preflight", result);
    }
  } finally {
    ctx.db.close();
  }
}
