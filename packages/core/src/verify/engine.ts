import type { StoreQueries } from "../store/queries";
import type { Ledger } from "../ledger/ledger";
import { checkIndexFreshness } from "./checks/index-freshness";
import { checkMissingTests } from "./checks/missing-tests";
import { checkTypecheck } from "./checks/typecheck";

export interface VerifyReport {
  status: "OK" | "FAIL";
  timestamp: number;
  checks: {
    indexFreshness: { passed: boolean; issues: unknown[] };
    testCoverage: { passed: boolean; issues: unknown[] };
    typecheck: { passed: boolean; issues: unknown[] };
  };
  summary: string;
}

export class VerifyEngine {
  constructor(
    private store: StoreQueries,
    private ledger: Ledger,
    private repoRoot: string,
  ) {}

  verify(): VerifyReport {
    const indexFreshness = checkIndexFreshness(this.store, this.repoRoot);
    const testCoverage = checkMissingTests(this.ledger);
    const typecheck = checkTypecheck(this.repoRoot);

    const allPassed =
      indexFreshness.passed && testCoverage.passed && typecheck.passed;

    const failedNames: string[] = [];
    if (!indexFreshness.passed) failedNames.push("indexFreshness");
    if (!testCoverage.passed) failedNames.push("testCoverage");
    if (!typecheck.passed) failedNames.push("typecheck");

    const summary = allPassed
      ? "all checks passed"
      : `failed checks: ${failedNames.join(", ")}`;

    return {
      status: allPassed ? "OK" : "FAIL",
      timestamp: Date.now(),
      checks: {
        indexFreshness,
        testCoverage,
        typecheck,
      },
      summary,
    };
  }
}
