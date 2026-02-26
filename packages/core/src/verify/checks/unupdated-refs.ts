import type { StoreQueries } from "../../store/queries";

export interface UnupdatedRefIssue {
  type: "UNUPDATED_REF";
  symbolId: string;
  filePath: string;
  reason: string;
}

export interface UnupdatedRefResult {
  passed: boolean;
  issues: UnupdatedRefIssue[];
}

/**
 * MVP placeholder: always passes.
 *
 * TODO: Implement diff-based signature change detection.
 * Future implementation should:
 *   1. Detect symbol signature changes (parameters, return types)
 *   2. Find all references to changed symbols
 *   3. Flag references that haven't been updated to match the new signature
 */
export function checkUnupdatedRefs(_store: StoreQueries): UnupdatedRefResult {
  return { passed: true, issues: [] };
}
