import type { StoreQueries } from "../../store/queries";

export interface FreshnessIssue {
  type: "INDEX_STALE";
  path: string;
  reason: string;
}

export interface FreshnessResult {
  passed: boolean;
  issues: FreshnessIssue[];
}

/**
 * Check whether the index is fresh by examining the dirty set.
 * Fails if there are unindexed changes since the last full SCIP pass.
 */
export function checkIndexFreshness(
  store: StoreQueries,
  _repoRoot: string,
): FreshnessResult {
  const dirtyPaths = store.getDirtyPaths();

  if (dirtyPaths.length === 0) {
    return { passed: true, issues: [] };
  }

  // Check if last full SCIP index covers all dirty entries
  const lastFullStr = store.getMeta("last_full_scip_index_ts");
  const lastFull = lastFullStr ? parseInt(lastFullStr, 10) : 0;
  const newestDirty = dirtyPaths[0].changed_at; // sorted DESC

  if (lastFull >= newestDirty) {
    return { passed: true, issues: [] };
  }

  const issues: FreshnessIssue[] = dirtyPaths
    .filter((d) => d.changed_at > lastFull)
    .map((d) => ({
      type: "INDEX_STALE" as const,
      path: d.path,
      reason: "file changed since last full index",
    }));

  return {
    passed: issues.length === 0,
    issues,
  };
}
