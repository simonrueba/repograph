import type { Ledger } from "../../ledger/ledger";

export interface MissingTestIssue {
  type: "MISSING_TEST_RUN";
  reason: string;
}

export interface MissingTestResult {
  passed: boolean;
  issues: MissingTestIssue[];
}

/**
 * Check whether tests have been run after the last edit recorded in the ledger.
 * Uses `ledger.hasTestAfterLastEdit()` to determine freshness.
 */
export function checkMissingTests(ledger: Ledger): MissingTestResult {
  const hasTest = ledger.hasTestAfterLastEdit();

  if (hasTest) {
    return { passed: true, issues: [] };
  }

  return {
    passed: false,
    issues: [
      {
        type: "MISSING_TEST_RUN",
        reason: "no test_run event found after the latest edit event",
      },
    ],
  };
}
