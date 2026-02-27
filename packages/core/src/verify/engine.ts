import type { StoreQueries } from "../store/queries";
import type { Ledger } from "../ledger/ledger";
import { checkIndexFreshness } from "./checks/index-freshness";
import { checkMissingTests } from "./checks/missing-tests";
import { checkTypecheck, checkTypecheckAsync, type TypecheckIssue } from "./checks/typecheck";
import { checkBoundaries } from "./checks/boundaries";

export interface VerifyReport {
  status: "OK" | "FAIL";
  timestamp: number;
  checks: {
    indexFreshness: { passed: boolean; issues: unknown[] };
    testCoverage: { passed: boolean; issues: unknown[] };
    typecheck: { passed: boolean; issues: unknown[] };
    boundaries?: { passed: boolean; issues: unknown[] };
  };
  summary: string;
  /**
   * High-level ariadne query recommendations, populated when typecheck
   * fails. Lists the top files by error count and useful follow-up commands.
   */
  recommendations?: string[];
}

/**
 * Build the `recommendations` array for a failed typecheck result.
 *
 * Strategy:
 *  1. List the top-5 files with the most errors, sorted descending.
 *  2. For each of those files, emit an `impact` command.
 *  3. Collect all unique `suggestedQueries` from individual issues and
 *     de-duplicate them (capped to avoid noise).
 *  4. Append a general guidance note.
 */
function buildTypecheckRecommendations(issues: TypecheckIssue[]): string[] {
  const recommendations: string[] = [];

  // ── 1. Count errors per file ──────────────────────────────────────────
  const errorsByFile = new Map<string, number>();
  for (const issue of issues) {
    if (issue.file) {
      errorsByFile.set(issue.file, (errorsByFile.get(issue.file) ?? 0) + 1);
    }
  }

  // Sort files by error count descending, take top 5.
  const topFiles = [...errorsByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file]) => file);

  // ── 2. Impact commands for the top files ────────────────────────────
  for (const file of topFiles) {
    const count = errorsByFile.get(file)!;
    recommendations.push(
      `ariadne query impact ${file}  # ${count} error${count === 1 ? "" : "s"}`,
    );
  }

  // ── 3. Unique per-issue suggestions (de-duplicated, capped at 10) ────
  const seen = new Set<string>(recommendations);
  for (const issue of issues) {
    for (const q of issue.suggestedQueries ?? []) {
      if (!seen.has(q)) {
        seen.add(q);
        recommendations.push(q);
        if (recommendations.length >= 15) break;
      }
    }
    if (recommendations.length >= 15) break;
  }

  // ── 4. General guidance note ─────────────────────────────────────────
  if (topFiles.length > 0) {
    recommendations.push(
      `Run \`ariadne query impact <file>\` to see the blast radius of any file above`,
    );
  }

  return recommendations;
}

export class VerifyEngine {
  constructor(
    private store: StoreQueries,
    private ledger: Ledger,
    private repoRoot: string,
  ) {}

  async verify(): Promise<VerifyReport> {
    // Guard: detect empty index to prevent vacuous pass
    const allFiles = this.store.getAllFiles();
    if (allFiles.length === 0) {
      return {
        status: "FAIL",
        timestamp: Date.now(),
        checks: {
          indexFreshness: {
            passed: false,
            issues: [{ type: "INDEX_EMPTY", path: "", reason: "no files indexed — run 'ariadne index' or 'ariadne setup'" }],
          },
          testCoverage: { passed: true, issues: [] },
          typecheck: { passed: true, issues: [] },
        },
        summary: "failed checks: indexFreshness",
      };
    }

    // Run fast synchronous checks in parallel with the slow async typecheck.
    // Total time ≈ max(typecheck, other_checks) instead of sum.
    const [indexFreshness, testCoverage, boundaries, typecheck] = await Promise.all([
      Promise.resolve(checkIndexFreshness(this.store, this.repoRoot)),
      Promise.resolve(checkMissingTests(this.ledger)),
      Promise.resolve(checkBoundaries(this.store, this.repoRoot)),
      checkTypecheckAsync(this.repoRoot),
    ]);

    const allPassed =
      indexFreshness.passed && testCoverage.passed && typecheck.passed && boundaries.passed;

    const failedNames: string[] = [];
    if (!indexFreshness.passed) failedNames.push("indexFreshness");
    if (!testCoverage.passed) failedNames.push("testCoverage");
    if (!typecheck.passed) failedNames.push("typecheck");
    if (!boundaries.passed) failedNames.push("boundaries");

    const summary = allPassed
      ? "all checks passed"
      : `failed checks: ${failedNames.join(", ")}`;

    const report: VerifyReport = {
      status: allPassed ? "OK" : "FAIL",
      timestamp: Date.now(),
      checks: {
        indexFreshness,
        testCoverage,
        typecheck,
        boundaries,
      },
      summary,
    };

    if (!typecheck.passed && typecheck.issues.length > 0) {
      report.recommendations = buildTypecheckRecommendations(
        typecheck.issues as TypecheckIssue[],
      );
    }

    // Non-blocking warning: files indexed but no symbols (SCIP likely failed)
    const symbolCount = this.store.getSymbolCount();
    if (allFiles.length > 0 && symbolCount === 0) {
      if (!report.recommendations) report.recommendations = [];
      report.recommendations.push(
        `Warning: ${allFiles.length} files indexed but 0 symbols — SCIP indexing likely failed or was skipped. Run 'ariadne doctor' to check prerequisites.`,
      );
    }

    return report;
  }
}
