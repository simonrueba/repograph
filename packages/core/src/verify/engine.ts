import type { StoreQueries } from "../store/queries";
import type { Ledger } from "../ledger/ledger";
import { checkIndexFreshness } from "./checks/index-freshness";
import { checkMissingTests } from "./checks/missing-tests";
import { checkUnupdatedRefs } from "./checks/unupdated-refs";

export interface VerifyReport {
  status: "OK" | "FAIL";
  timestamp: number;
  checks: {
    indexFreshness: { passed: boolean; issues: unknown[] };
    testCoverage: { passed: boolean; issues: unknown[] };
    unupdatedRefs: { passed: boolean; issues: unknown[] };
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
    const unupdatedRefs = checkUnupdatedRefs(this.store);

    const allPassed =
      indexFreshness.passed && testCoverage.passed && unupdatedRefs.passed;

    const failedNames: string[] = [];
    if (!indexFreshness.passed) failedNames.push("indexFreshness");
    if (!testCoverage.passed) failedNames.push("testCoverage");
    if (!unupdatedRefs.passed) failedNames.push("unupdatedRefs");

    const summary = allPassed
      ? "all checks passed"
      : `failed checks: ${failedNames.join(", ")}`;

    return {
      status: allPassed ? "OK" : "FAIL",
      timestamp: Date.now(),
      checks: {
        indexFreshness,
        testCoverage,
        unupdatedRefs,
      },
      summary,
    };
  }
}
