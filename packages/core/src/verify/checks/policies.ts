import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { StoreQueries } from "../../store/queries";
import { StructuralMetrics } from "../../graph/metrics";

export interface PolicyConfig {
  policies: {
    max_public_api_growth?: number;
    deny_new_cycles?: boolean;
    max_coupling_increase?: number;
    require_tests_for_changed_exports?: boolean;
  };
}

export interface PolicyIssue {
  type: "POLICY_VIOLATION";
  policy: string;
  message: string;
}

export interface PolicyCheckResult {
  passed: boolean;
  issues: PolicyIssue[];
}

/**
 * Load `ariadne.policies.json`, compute current metrics, compare against
 * saved baseline snapshot, and report violations.
 *
 * Returns pass if no config file exists or if no baseline snapshot is saved.
 */
export function checkPolicies(
  store: StoreQueries,
  repoRoot: string,
): PolicyCheckResult {
  const configPath = join(repoRoot, "ariadne.policies.json");
  if (!existsSync(configPath)) {
    return { passed: true, issues: [] };
  }

  let config: PolicyConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { passed: true, issues: [] };
  }

  if (!config.policies) {
    return { passed: true, issues: [] };
  }

  const metrics = new StructuralMetrics(store, repoRoot);
  const baseline = metrics.loadSnapshot();

  // No baseline yet — nothing to compare against
  if (!baseline) {
    return { passed: true, issues: [] };
  }

  const current = metrics.computeMetrics();
  const diff = metrics.diff(current, baseline);
  const issues: PolicyIssue[] = [];

  // Policy: deny_new_cycles
  if (config.policies.deny_new_cycles && diff.newCycles.length > 0) {
    for (const cycle of diff.newCycles) {
      issues.push({
        type: "POLICY_VIOLATION",
        policy: "deny_new_cycles",
        message: `New dependency cycle detected: ${cycle.members.join(" → ")} (${cycle.size} files)`,
      });
    }
  }

  // Policy: max_public_api_growth
  if (config.policies.max_public_api_growth !== undefined) {
    const maxGrowth = config.policies.max_public_api_growth;
    for (const growth of diff.apiGrowth) {
      if (growth.growth > maxGrowth) {
        issues.push({
          type: "POLICY_VIOLATION",
          policy: "max_public_api_growth",
          message: `Package "${growth.packageId}" API grew by ${growth.growth} symbols (max allowed: ${maxGrowth})`,
        });
      }
    }
  }

  // Policy: max_coupling_increase
  if (config.policies.max_coupling_increase !== undefined) {
    const maxIncrease = config.policies.max_coupling_increase;
    for (const ci of diff.couplingIncreases) {
      if (ci.increase > maxIncrease) {
        issues.push({
          type: "POLICY_VIOLATION",
          policy: "max_coupling_increase",
          message: `Module "${ci.module}" coupling metric ${ci.metric} increased by ${ci.increase} (max allowed: ${maxIncrease})`,
        });
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}
