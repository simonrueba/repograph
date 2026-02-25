import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export interface TypecheckIssue {
  type: "TYPE_ERROR";
  message: string;
}

export interface TypecheckResult {
  passed: boolean;
  issues: TypecheckIssue[];
}

/** Find the tsc binary — prefer local node_modules, fall back to bunx. */
function findTscCommand(repoRoot: string): string {
  const localTsc = join(repoRoot, "node_modules", ".bin", "tsc");
  if (existsSync(localTsc)) {
    return localTsc;
  }
  return "bunx tsc";
}

/**
 * Run the TypeScript compiler in noEmit mode to catch type errors.
 * Looks for tsconfig.json in the repo root. Skips if none found.
 */
export function checkTypecheck(repoRoot: string): TypecheckResult {
  const tsconfigPath = join(repoRoot, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    return { passed: true, issues: [] };
  }

  const tsc = findTscCommand(repoRoot);

  try {
    execSync(`${tsc} --noEmit -p ${tsconfigPath}`, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { passed: true, issues: [] };
  } catch (err: any) {
    const output = (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
    const lines = output
      .split("\n")
      .filter((l: string) => l.includes("error TS"))
      .slice(0, 20); // cap at 20 errors

    return {
      passed: false,
      issues: lines.map((message: string) => ({
        type: "TYPE_ERROR" as const,
        message: message.trim(),
      })),
    };
  }
}
