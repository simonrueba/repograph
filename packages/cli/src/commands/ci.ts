import { execFileSync } from "child_process";
import {
  ImpactAnalyzer,
  VerifyEngine,
  StructuralMetrics,
  redactReport,
  type RiskBreakdown,
} from "ariadne-core";
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
 * Get changed files by diffing against a base branch.
 * Falls back to listing all tracked files if diff fails (e.g. shallow clone).
 */
function getChangedFiles(repoRoot: string, baseBranch: string): string[] {
  try {
    // Ensure we have the base branch ref (CI may be a shallow clone)
    try {
      execFileSync("git", ["fetch", "origin", baseBranch, "--depth=1"], {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
      });
    } catch {
      // May already have the ref — continue
    }

    const raw = execFileSync(
      "git",
      ["diff", "--name-only", `origin/${baseBranch}...HEAD`],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    // Fallback: diff against HEAD~1
    try {
      const raw = execFileSync("git", ["diff", "--name-only", "HEAD~1"], {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

// Risk factor weights — must match computeRiskScore() in core
const RISK_WEIGHTS: Record<keyof RiskBreakdown, { weight: number; label: string }> = {
  fileSpread: { weight: 0.25, label: "File Spread" },
  publicApiBreak: { weight: 0.30, label: "Public API Break" },
  packageSpread: { weight: 0.15, label: "Package Spread" },
  testGap: { weight: 0.20, label: "Test Gap" },
  boundary: { weight: 0.10, label: "Boundary" },
};

/**
 * Build actionable recommendations from the report data.
 * Merges verify-engine recommendations with risk-driven suggestions.
 * Prioritises the highest contributing risk factors.
 */
export function _buildRecommendations(report: CiReport): string[] {
  const recs: string[] = [];

  // Start with verify-engine recommendations (policy violations, etc.)
  if (report.verify.failedChecks.length > 0) {
    recs.push("Run `ariadne verify` to see full policy violation details.");
  }

  // Test gap: list top untested files by depth (closest first)
  if (report.riskBreakdown.testGap > 0.3) {
    const testedPaths = new Set(report.testFiles.map((t) => t.path));
    const untested = report.allAffectedFiles
      .filter((f) => !testedPaths.has(f.path) && !f.path.match(/\.(test|spec)\./))
      .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

    if (untested.length > 0) {
      const top = untested.slice(0, 5).map((f) => `\`${f.path}\``).join(", ");
      const msg = untested.length <= 5
        ? `Add tests for untested affected files: ${top}`
        : `Add tests for untested affected files (${untested.length} total, highest priority): ${top}`;
      recs.push(msg);
    }
  }

  // Public API breaks: warn about downstream impact
  if (report.publicApiBreakDetails.length > 0) {
    const allDownstream = new Set(report.publicApiBreakDetails.flatMap((b) => b.downstream));
    if (allDownstream.size > 0) {
      recs.push(`Public API changes affect ${allDownstream.size} downstream consumer(s): ${[...allDownstream].join(", ")}. Verify compatibility.`);
    }
  }

  // New cycles
  if (report.metricsDiff?.newCycles && report.metricsDiff.newCycles.length > 0) {
    recs.push("New dependency cycles detected. Run `ariadne metrics --diff` to see cycle members and plan decoupling.");
  }

  // Coupling increases
  if (report.metricsDiff?.couplingIncreases && report.metricsDiff.couplingIncreases.length > 3) {
    recs.push(`${report.metricsDiff.couplingIncreases.length} modules have increased coupling. Consider extracting shared interfaces.`);
  }

  // Boundary risk
  if (report.boundaryViolationRisk === "high") {
    recs.push("High boundary violation risk. Run `ariadne boundaries` to check cross-boundary imports.");
  }

  return recs;
}

const buildRecommendations = _buildRecommendations;

/**
 * Generate a rich markdown PR comment from the CI report data.
 * The 'Ariadne Structural Report' marker is preserved for GitHub Action deduplication.
 */
function generateMarkdown(report: CiReport): string {
  const { summary, verify, riskBreakdown, publicApiBreakDetails, testFiles,
    allAffectedFiles, affectedPackages, boundaryViolationRisk,
    recommendations, metricsDiff } = report;

  const riskIcon =
    summary.riskCategory === "critical" ? "🔴"
    : summary.riskCategory === "high" ? "🟠"
    : summary.riskCategory === "medium" ? "🟡"
    : "🟢";

  // Compute weighted contributions for each factor
  const contributions = (Object.keys(RISK_WEIGHTS) as (keyof RiskBreakdown)[]).map((key) => ({
    key,
    label: RISK_WEIGHTS[key].label,
    value: riskBreakdown[key],
    weight: RISK_WEIGHTS[key].weight,
    contribution: Math.round(riskBreakdown[key] * RISK_WEIGHTS[key].weight * 1000) / 1000,
  }));
  // Sort by contribution descending; tie-break by weight descending, then key alphabetical
  contributions.sort((a, b) =>
    b.contribution - a.contribution || b.weight - a.weight || a.key.localeCompare(b.key),
  );

  // Lede: top 3 drivers with contribution >= 0.01
  const topDrivers = contributions.filter((c) => c.contribution >= 0.01).slice(0, 3);
  const ledeDrivers = topDrivers.map((d) => `${d.label} (${d.contribution.toFixed(2)})`).join(", ");

  let md = `## 🔍 Ariadne Structural Report\n\n`;
  md += `> **Risk: ${summary.riskScore.toFixed(2)} ${riskIcon} ${summary.riskCategory}**`;
  if (ledeDrivers) md += ` — ${ledeDrivers}`;
  md += `\n\n`;

  // Summary table
  const impactRadiusText = affectedPackages.length > 1
    ? `${summary.impactRadius} files across ${affectedPackages.length} packages`
    : `${summary.impactRadius} files`;

  const directTests = testFiles.filter((t) => t.relevance === "direct").length;
  const transitiveTests = testFiles.filter((t) => t.relevance === "transitive").length;
  const testText = summary.testCount > 0
    ? `${summary.testCount} (${directTests} direct, ${transitiveTests} transitive)`
    : "0";

  const boundaryIcon = boundaryViolationRisk === "high" ? "🔴"
    : boundaryViolationRisk === "medium" ? "🟡"
    : boundaryViolationRisk === "low" ? "🟢"
    : "⚪";

  const policyIcon = summary.policyPassed ? "✅" : "❌";
  const policyText = summary.policyPassed ? "PASSED" : "FAILED";

  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Changed Files | ${report.changedFiles.length} |\n`;
  md += `| Impact Radius | ${impactRadiusText} |\n`;
  md += `| Public API Breaks | ${summary.publicApiBreaks} symbols |\n`;
  md += `| Boundary Risk | ${boundaryIcon} ${boundaryViolationRisk} |\n`;
  md += `| New Cycles | ${summary.newCycles} |\n`;
  md += `| Tests | ${testText} |\n`;
  md += `| Policy | ${policyIcon} ${policyText} |\n`;

  // Risk Drivers table
  md += `\n### Risk Drivers\n\n`;
  md += `| Factor | Score | Weight | Contribution |\n`;
  md += `|--------|-------|--------|-------------|\n`;
  for (const c of contributions) {
    const bold = c === contributions[0] && c.contribution > 0;
    const contribText = bold ? `**${c.contribution.toFixed(2)}**` : c.contribution.toFixed(2);
    md += `| ${c.label} | ${c.value.toFixed(2)} | ×${c.weight.toFixed(2)} | ${contribText} |\n`;
  }

  // Public API Breaks
  if (publicApiBreakDetails.length > 0) {
    md += `\n### Public API Breaks\n\n`;
    md += `| Symbol | Downstream |\n`;
    md += `|--------|------------|\n`;
    for (const b of publicApiBreakDetails) {
      md += `| \`${b.symbolName}\` | ${b.downstream.join(", ")} |\n`;
    }
  }

  // Verification issues
  if (verify.failedChecks.length > 0) {
    md += `\n### Verification Issues\n\n`;
    for (const check of verify.failedChecks) {
      md += `- ❌ **${check.name}**: ${check.summary}\n`;
    }
  }

  // Recommendations
  if (recommendations.length > 0) {
    md += `\n### Recommendations\n\n`;
    for (const rec of recommendations) {
      md += `- ${rec}\n`;
    }
  }

  // New Dependency Cycles
  if (metricsDiff && metricsDiff.newCycles.length > 0) {
    const count = metricsDiff.newCycles.length;
    md += `\n### New Dependency Cycles\n\n`;
    md += `<details><summary>${count} new cycle${count === 1 ? "" : "s"}</summary>\n\n`;
    for (const cycle of metricsDiff.newCycles) {
      md += `\`${cycle.members.join("` → `")}\` → \`${cycle.members[0]}\`\n\n`;
    }
    md += `</details>\n`;
  }

  // Coupling Changes
  if (metricsDiff && metricsDiff.couplingIncreases.length > 0) {
    const count = metricsDiff.couplingIncreases.length;
    md += `\n### Coupling Changes\n\n`;
    md += `<details><summary>${count} module${count === 1 ? "" : "s"} with increased coupling</summary>\n\n`;
    md += `| Module | Metric | \u0394 |\n`;
    md += `|--------|--------|---|\n`;
    for (const c of metricsDiff.couplingIncreases) {
      md += `| \`${c.module}\` | ${c.metric} | +${c.increase} |\n`;
    }
    md += `\n</details>\n`;
  }

  // Impact Details
  if (allAffectedFiles.length > 0) {
    md += `\n### Impact Details\n\n`;
    md += `<details><summary>${allAffectedFiles.length} affected files</summary>\n\n`;

    const direct = allAffectedFiles.filter((f) => f.depth === 1);
    const transitive = allAffectedFiles.filter((f) => f.depth > 1);

    if (direct.length > 0) {
      md += `**Direct (depth 1)**\n`;
      const shownDirect = direct.slice(0, 20);
      for (const f of shownDirect) {
        md += `- \`${f.path}\` — ${f.reason}\n`;
      }
      if (direct.length > 20) {
        md += `- ... showing 20 of ${direct.length} direct files\n`;
      }
    }

    if (transitive.length > 0) {
      md += `\n**Transitive (depth 2+)**\n`;
      const shownTransitive = transitive.slice(0, 30);
      for (const f of shownTransitive) {
        md += `- \`${f.path}\` — ${f.reason}\n`;
      }
      if (transitive.length > 30) {
        md += `- ... showing 30 of ${transitive.length} transitive files\n`;
      }
    }

    md += `\n</details>\n`;
  }

  md += `\n---\n<sub>Generated by <a href="https://github.com/simonrueba/ariadne">Ariadne</a> — structural intelligence for AI coding agents</sub>\n`;

  return md;
}

/** Exported for testing. */
export { generateMarkdown as _generateMarkdown };

export interface CiReport {
  changedFiles: string[];
  impact: {
    riskScore: number;
    riskCategory: string;
    affectedFileCount: number;
    publicApiBreaks: number;
    testCount: number;
    topAffectedFiles: { path: string; depth: number; reason: string }[];
  };
  verify: {
    status: string;
    passed: boolean;
    failedChecks: { name: string; summary: string }[];
  };
  metrics: {
    newCycles: number;
    couplingChanges: number;
  };
  summary: {
    riskScore: number;
    riskCategory: string;
    policyPassed: boolean;
    impactRadius: number;
    publicApiBreaks: number;
    newCycles: number;
    testCount: number;
  };
  // NEW fields — additive only
  allAffectedFiles: { path: string; depth: number; reason: string }[];
  changedSymbols: { id: string; name: string; filePath: string; isPublicApi: boolean }[];
  publicApiBreakDetails: { symbolId: string; symbolName: string; downstream: string[] }[];
  affectedPackages: string[];
  boundaryViolationRisk: "none" | "low" | "medium" | "high";
  testFiles: { path: string; relevance: "direct" | "transitive" }[];
  riskBreakdown: RiskBreakdown;
  metricsDiff?: {
    newCycles: { members: string[]; size: number }[];
    couplingIncreases: { module: string; metric: string; increase: number }[];
    apiGrowth: { packageId: string; growth: number }[];
  };
  recommendations: string[];
  markdown: string;
}

/**
 * CI command — single command for GitHub Actions / CI pipelines.
 *
 * Usage:
 *   ariadne ci [--base main] [--markdown] [--root <path>]
 *
 * Runs impact analysis on changed files, verification, and metrics.
 * Outputs structured JSON (default) or markdown PR comment.
 */
export async function runCi(args: string[]): Promise<void> {
  const baseBranch = extractFlag(args, "--base") ?? "main";
  const formatMarkdown = args.includes("--markdown");
  const rootArg = extractFlag(args, "--root");
  const repoRoot = rootArg || process.cwd();

  // 1. Get changed files
  const changedFiles = getChangedFiles(repoRoot, baseBranch);

  if (changedFiles.length === 0) {
    const emptyBreakdown: RiskBreakdown = { fileSpread: 0, publicApiBreak: 0, packageSpread: 0, testGap: 0, boundary: 0 };
    const emptyReport: CiReport = {
      changedFiles: [],
      impact: {
        riskScore: 0,
        riskCategory: "low",
        affectedFileCount: 0,
        publicApiBreaks: 0,
        testCount: 0,
        topAffectedFiles: [],
      },
      verify: { status: "OK", passed: true, failedChecks: [] },
      metrics: { newCycles: 0, couplingChanges: 0 },
      summary: {
        riskScore: 0,
        riskCategory: "low",
        policyPassed: true,
        impactRadius: 0,
        publicApiBreaks: 0,
        newCycles: 0,
        testCount: 0,
      },
      allAffectedFiles: [],
      changedSymbols: [],
      publicApiBreakDetails: [],
      affectedPackages: [],
      boundaryViolationRisk: "none",
      testFiles: [],
      riskBreakdown: emptyBreakdown,
      recommendations: [],
      markdown: "## 🔍 Ariadne Structural Report\n\nNo changed files detected.\n",
    };
    if (formatMarkdown) {
      console.log(emptyReport.markdown);
    } else {
      output("ci_report", emptyReport);
    }
    return;
  }

  // 2. Get context (index must exist — setup should run before ci)
  let ctx;
  try {
    ctx = getContext(rootArg);
  } catch {
    outputError(
      "NOT_INITIALIZED",
      "Ariadne index not found. Run 'ariadne setup' first.",
    );
  }

  try {
    // 3. Impact analysis on changed files
    const analyzer = new ImpactAnalyzer(ctx.store, ctx.repoRoot);
    const impactResult = analyzer.computeTransitiveImpact(changedFiles);

    // 4. Verification
    const engine = new VerifyEngine(ctx.store, ctx.ledger, ctx.repoRoot);
    const verifyResult = await engine.verify();
    const redacted = redactReport(verifyResult);

    // 5. Metrics diff (if baseline exists)
    const metricsEngine = new StructuralMetrics(ctx.store, ctx.repoRoot);
    const baseline = metricsEngine.loadSnapshot();
    let newCycles = 0;
    let couplingChanges = 0;
    let metricsDiff: CiReport["metricsDiff"];
    if (baseline) {
      const current = metricsEngine.computeMetrics();
      const diff = metricsEngine.diff(current, baseline);
      newCycles = diff.newCycles.length;
      couplingChanges = diff.couplingIncreases.length;
      metricsDiff = {
        newCycles: diff.newCycles,
        couplingIncreases: diff.couplingIncreases,
        apiGrowth: diff.apiGrowth,
      };
    }

    // 6. Build failed checks summary
    const failedChecks: { name: string; summary: string }[] = [];
    const checks = redacted.checks as Record<string, any>;
    for (const [name, check] of Object.entries(checks)) {
      if (check && !check.passed) {
        const issues = check.issues ?? check.errors ?? [];
        const count = Array.isArray(issues) ? issues.length : 0;
        const firstMsg =
          count > 0 && issues[0]?.message
            ? issues[0].message
            : `${count} issue(s)`;
        failedChecks.push({ name, summary: firstMsg });
      }
    }

    // 7. Build report
    const report: CiReport = {
      changedFiles,
      impact: {
        riskScore: impactResult.riskScore,
        riskCategory: impactResult.riskCategory,
        affectedFileCount: impactResult.affectedFiles.length,
        publicApiBreaks: impactResult.publicApiBreaks.length,
        testCount: impactResult.testCount,
        topAffectedFiles: impactResult.affectedFiles.slice(0, 10),
      },
      verify: {
        status: verifyResult.status,
        passed: verifyResult.status === "OK",
        failedChecks,
      },
      metrics: { newCycles, couplingChanges },
      summary: {
        riskScore: impactResult.riskScore,
        riskCategory: impactResult.riskCategory,
        policyPassed: verifyResult.status === "OK",
        impactRadius: impactResult.affectedFiles.length,
        publicApiBreaks: impactResult.publicApiBreaks.length,
        newCycles,
        testCount: impactResult.testCount,
      },
      allAffectedFiles: impactResult.affectedFiles,
      changedSymbols: impactResult.changedSymbols,
      publicApiBreakDetails: impactResult.publicApiBreaks,
      affectedPackages: impactResult.affectedPackages,
      boundaryViolationRisk: impactResult.boundaryViolationRisk,
      testFiles: impactResult.testFiles,
      riskBreakdown: impactResult.riskBreakdown,
      metricsDiff,
      recommendations: [],
      markdown: "",
    };

    // 8. Build smart recommendations from report data
    report.recommendations = buildRecommendations(report);

    report.markdown = generateMarkdown(report);

    if (formatMarkdown) {
      console.log(report.markdown);
    } else {
      output("ci_report", report);
    }

    // Exit non-zero if verification failed
    if (verifyResult.status !== "OK") {
      process.exit(1);
    }
  } finally {
    ctx.db.close();
  }
}
