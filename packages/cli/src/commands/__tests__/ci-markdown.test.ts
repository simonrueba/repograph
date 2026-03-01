import { describe, it, expect } from "vitest";
import { _generateMarkdown as generateMarkdown, _buildRecommendations as buildRecommendations, type CiReport } from "../ci";
import type { RiskBreakdown } from "ariadne-core";

function makeReport(overrides: Partial<CiReport> = {}): CiReport {
  const defaultBreakdown: RiskBreakdown = {
    fileSpread: 0,
    publicApiBreak: 0,
    packageSpread: 0,
    testGap: 0,
    boundary: 0,
  };
  return {
    changedFiles: ["src/a.ts"],
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
    riskBreakdown: defaultBreakdown,
    recommendations: [],
    markdown: "",
    ...overrides,
  };
}

describe("generateMarkdown", () => {
  it("should contain the Ariadne Structural Report marker", () => {
    const md = generateMarkdown(makeReport());
    expect(md).toContain("Ariadne Structural Report");
  });

  it("should show Risk Drivers table", () => {
    const md = generateMarkdown(makeReport({
      riskBreakdown: { fileSpread: 0.5, publicApiBreak: 1.0, packageSpread: 0.2, testGap: 0.3, boundary: 0.1 },
      summary: { riskScore: 0.72, riskCategory: "high", policyPassed: true, impactRadius: 10, publicApiBreaks: 2, newCycles: 0, testCount: 3 },
    }));
    expect(md).toContain("### Risk Drivers");
    expect(md).toContain("Public API Break");
    expect(md).toContain("File Spread");
    expect(md).toContain("Test Gap");
  });

  it("should show Public API Breaks section when breaks exist", () => {
    const md = generateMarkdown(makeReport({
      publicApiBreakDetails: [
        { symbolId: "s1", symbolName: "computeRiskScore", downstream: ["packages/cli", "packages/mcp"] },
      ],
      summary: { riskScore: 0.3, riskCategory: "medium", policyPassed: true, impactRadius: 5, publicApiBreaks: 1, newCycles: 0, testCount: 0 },
    }));
    expect(md).toContain("### Public API Breaks");
    expect(md).toContain("`computeRiskScore`");
    expect(md).toContain("packages/cli");
  });

  it("should omit Public API Breaks section when no breaks", () => {
    const md = generateMarkdown(makeReport());
    expect(md).not.toContain("### Public API Breaks");
  });

  it("should show cycle member names in New Dependency Cycles", () => {
    const md = generateMarkdown(makeReport({
      metricsDiff: {
        newCycles: [{ members: ["a.ts", "b.ts", "c.ts"], size: 3 }],
        couplingIncreases: [],
        apiGrowth: [],
      },
      summary: { riskScore: 0.5, riskCategory: "medium", policyPassed: true, impactRadius: 5, publicApiBreaks: 0, newCycles: 1, testCount: 0 },
    }));
    expect(md).toContain("### New Dependency Cycles");
    expect(md).toContain("`a.ts`");
    expect(md).toContain("`b.ts`");
    expect(md).toContain("`c.ts`");
  });

  it("should show full file count in Impact Details", () => {
    const files = Array.from({ length: 47 }, (_, i) => ({
      path: `src/file${i}.ts`,
      depth: i < 10 ? 1 : 2,
      reason: "imports something",
    }));
    const md = generateMarkdown(makeReport({
      allAffectedFiles: files,
      summary: { riskScore: 0.5, riskCategory: "medium", policyPassed: true, impactRadius: 47, publicApiBreaks: 0, newCycles: 0, testCount: 0 },
    }));
    expect(md).toContain("47 affected files");
    expect(md).toContain("**Direct (depth 1)**");
    expect(md).toContain("**Transitive (depth 2+)**");
  });

  it("should list top drivers in lede line by weighted contribution", () => {
    const md = generateMarkdown(makeReport({
      riskBreakdown: { fileSpread: 0.47, publicApiBreak: 1.0, packageSpread: 0.4, testGap: 0.8, boundary: 0.8 },
      summary: { riskScore: 0.72, riskCategory: "high", policyPassed: false, impactRadius: 47, publicApiBreaks: 2, newCycles: 1, testCount: 4 },
    }));
    // Public API Break (0.30) should be first, then Test Gap (0.16), then File Spread (0.12)
    expect(md).toMatch(/Risk: 0\.72.*high.*Public API Break.*Test Gap.*File Spread/);
  });

  it("should show recommendations when present", () => {
    const md = generateMarkdown(makeReport({
      recommendations: ["Run `ariadne metrics --diff` to see policy violations"],
    }));
    expect(md).toContain("### Recommendations");
    expect(md).toContain("ariadne metrics --diff");
  });

  it("should omit recommendations when empty", () => {
    const md = generateMarkdown(makeReport());
    expect(md).not.toContain("### Recommendations");
  });

  it("should show impact radius across packages when multiple", () => {
    const md = generateMarkdown(makeReport({
      affectedPackages: ["pkg-core", "pkg-cli"],
      summary: { riskScore: 0.3, riskCategory: "medium", policyPassed: true, impactRadius: 15, publicApiBreaks: 0, newCycles: 0, testCount: 0 },
    }));
    expect(md).toContain("15 files across 2 packages");
  });

  it("should show test breakdown with direct and transitive counts", () => {
    const md = generateMarkdown(makeReport({
      testFiles: [
        { path: "a.test.ts", relevance: "direct" },
        { path: "b.test.ts", relevance: "direct" },
        { path: "c.test.ts", relevance: "transitive" },
      ],
      summary: { riskScore: 0.1, riskCategory: "low", policyPassed: true, impactRadius: 5, publicApiBreaks: 0, newCycles: 0, testCount: 3 },
    }));
    expect(md).toContain("3 (2 direct, 1 transitive)");
  });

  it("should show explicit overflow counts when files exceed caps", () => {
    const directFiles = Array.from({ length: 25 }, (_, i) => ({
      path: `src/direct${i}.ts`, depth: 1, reason: "imports changed",
    }));
    const transitiveFiles = Array.from({ length: 35 }, (_, i) => ({
      path: `src/transitive${i}.ts`, depth: 2, reason: "transitive",
    }));
    const md = generateMarkdown(makeReport({
      allAffectedFiles: [...directFiles, ...transitiveFiles],
      summary: { riskScore: 0.5, riskCategory: "medium", policyPassed: true, impactRadius: 60, publicApiBreaks: 0, newCycles: 0, testCount: 0 },
    }));
    expect(md).toContain("showing 20 of 25 direct files");
    expect(md).toContain("showing 30 of 35 transitive files");
  });

  it("golden snapshot — full-featured report", () => {
    const report = makeReport({
      changedFiles: ["src/risk.ts", "src/impact.ts", "src/ci.ts"],
      riskBreakdown: { fileSpread: 0.47, publicApiBreak: 1.0, packageSpread: 0.4, testGap: 0.8, boundary: 0.8 },
      summary: {
        riskScore: 0.72, riskCategory: "high", policyPassed: false,
        impactRadius: 5, publicApiBreaks: 1, newCycles: 1, testCount: 2,
      },
      affectedPackages: ["pkg-core", "pkg-cli"],
      boundaryViolationRisk: "medium",
      publicApiBreakDetails: [
        { symbolId: "s1", symbolName: "computeRiskScore", downstream: ["packages/cli", "packages/mcp"] },
      ],
      testFiles: [
        { path: "risk.test.ts", relevance: "direct" },
        { path: "ci.test.ts", relevance: "transitive" },
      ],
      allAffectedFiles: [
        { path: "src/ci.ts", depth: 1, reason: "imports risk.ts" },
        { path: "src/setup.ts", depth: 1, reason: "imports risk.ts" },
        { path: "src/index.ts", depth: 2, reason: "imports ci.ts" },
        { path: "src/main.ts", depth: 2, reason: "imports ci.ts" },
        { path: "src/cli.ts", depth: 3, reason: "imports main.ts" },
      ],
      verify: { status: "FAIL", passed: false, failedChecks: [{ name: "policies", summary: "1 policy violation" }] },
      metricsDiff: {
        newCycles: [{ members: ["a.ts", "b.ts"], size: 2 }],
        couplingIncreases: [{ module: "impact.ts", metric: "Ce", increase: 2 }],
        apiGrowth: [],
      },
      recommendations: ["Run `ariadne verify` to see full details"],
    });

    const md = generateMarkdown(report);

    // Snapshot: verify exact structure (line-by-line would be fragile; check key sections exist in order)
    const sections = [
      "## 🔍 Ariadne Structural Report",
      "> **Risk: 0.72 🟠 high**",
      "Public API Break (0.30)",
      "| Metric | Value |",
      "| Changed Files | 3 |",
      "5 files across 2 packages",
      "1 symbols",
      "🟡 medium",
      "❌ FAILED",
      "### Risk Drivers",
      "| Public API Break | 1.00 | ×0.30 | **0.30** |",
      "| Test Gap | 0.80 | ×0.20 | 0.16 |",
      "| File Spread | 0.47 | ×0.25 | 0.12 |",
      "### Public API Breaks",
      "`computeRiskScore`",
      "### Verification Issues",
      "❌ **policies**: 1 policy violation",
      "### Recommendations",
      "ariadne verify",
      "### New Dependency Cycles",
      "`a.ts` → `b.ts` → `a.ts`",
      "### Coupling Changes",
      "| `impact.ts` | Ce | +2 |",
      "### Impact Details",
      "5 affected files",
      "**Direct (depth 1)**",
      "`src/ci.ts`",
      "**Transitive (depth 2+)**",
      "`src/index.ts`",
      "Generated by",
    ];

    for (const section of sections) {
      expect(md).toContain(section);
    }

    // Verify section ordering: each section appears after the previous
    let lastIdx = -1;
    for (const section of sections) {
      const idx = md.indexOf(section);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});

describe("buildRecommendations", () => {
  it("should recommend adding tests when testGap > 0.3", () => {
    const recs = buildRecommendations(makeReport({
      riskBreakdown: { fileSpread: 0, publicApiBreak: 0, packageSpread: 0, testGap: 0.8, boundary: 0 },
      allAffectedFiles: [
        { path: "src/core.ts", depth: 1, reason: "changed" },
        { path: "src/service.ts", depth: 1, reason: "imports core" },
        { path: "src/deep.ts", depth: 2, reason: "imports service" },
      ],
      testFiles: [],
    }));
    expect(recs.some((r) => r.includes("untested affected files"))).toBe(true);
    expect(recs.some((r) => r.includes("`src/core.ts`"))).toBe(true);
  });

  it("should list untested files sorted by depth (closest first)", () => {
    const recs = buildRecommendations(makeReport({
      riskBreakdown: { fileSpread: 0, publicApiBreak: 0, packageSpread: 0, testGap: 0.9, boundary: 0 },
      allAffectedFiles: [
        { path: "src/deep.ts", depth: 3, reason: "transitive" },
        { path: "src/core.ts", depth: 1, reason: "changed" },
        { path: "src/mid.ts", depth: 2, reason: "imports" },
      ],
      testFiles: [],
    }));
    const testRec = recs.find((r) => r.includes("untested"));
    expect(testRec).toBeDefined();
    // depth-1 file should appear before depth-2 and depth-3
    const coreIdx = testRec!.indexOf("`src/core.ts`");
    const midIdx = testRec!.indexOf("`src/mid.ts`");
    const deepIdx = testRec!.indexOf("`src/deep.ts`");
    expect(coreIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(deepIdx);
  });

  it("should not recommend tests when testGap <= 0.3", () => {
    const recs = buildRecommendations(makeReport({
      riskBreakdown: { fileSpread: 0, publicApiBreak: 0, packageSpread: 0, testGap: 0.2, boundary: 0 },
      allAffectedFiles: [{ path: "src/a.ts", depth: 1, reason: "changed" }],
      testFiles: [],
    }));
    expect(recs.every((r) => !r.includes("untested"))).toBe(true);
  });

  it("should warn about downstream consumers for public API breaks", () => {
    const recs = buildRecommendations(makeReport({
      publicApiBreakDetails: [
        { symbolId: "s1", symbolName: "compute", downstream: ["packages/cli", "packages/mcp"] },
      ],
    }));
    expect(recs.some((r) => r.includes("downstream consumer"))).toBe(true);
    expect(recs.some((r) => r.includes("packages/cli"))).toBe(true);
  });

  it("should recommend verify when there are failed checks", () => {
    const recs = buildRecommendations(makeReport({
      verify: { status: "FAIL", passed: false, failedChecks: [{ name: "policies", summary: "1 violation" }] },
    }));
    expect(recs.some((r) => r.includes("ariadne verify"))).toBe(true);
  });

  it("should recommend decoupling for new cycles", () => {
    const recs = buildRecommendations(makeReport({
      metricsDiff: {
        newCycles: [{ members: ["a.ts", "b.ts"], size: 2 }],
        couplingIncreases: [],
        apiGrowth: [],
      },
    }));
    expect(recs.some((r) => r.includes("dependency cycles"))).toBe(true);
  });

  it("should cap untested file list at 5", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `src/file${i}.ts`, depth: 1, reason: "changed",
    }));
    const recs = buildRecommendations(makeReport({
      riskBreakdown: { fileSpread: 0, publicApiBreak: 0, packageSpread: 0, testGap: 0.9, boundary: 0 },
      allAffectedFiles: files,
      testFiles: [],
    }));
    const testRec = recs.find((r) => r.includes("untested"));
    expect(testRec).toBeDefined();
    expect(testRec).toContain("20 total");
    // Should have exactly 5 backtick-quoted paths
    const matches = testRec!.match(/`src\/file\d+\.ts`/g);
    expect(matches).toHaveLength(5);
  });

  it("should return empty array when no issues", () => {
    const recs = buildRecommendations(makeReport());
    expect(recs).toEqual([]);
  });
});
