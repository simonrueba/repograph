import { describe, it, expect } from "vitest";
import { computeRiskScore, type RiskInputs } from "../risk";

function makeInputs(overrides: Partial<RiskInputs> = {}): RiskInputs {
  return {
    affectedFileCount: 0,
    totalFileCount: 100,
    publicApiBreakCount: 0,
    affectedPackageCount: 0,
    totalPackageCount: 5,
    untestedAffectedFileCount: 0,
    totalAffectedFileCount: 0,
    boundaryProximity: 0,
    ...overrides,
  };
}

describe("computeRiskScore", () => {
  it("should return zero score for zero inputs", () => {
    const result = computeRiskScore(makeInputs());
    expect(result.score).toBe(0);
    expect(result.category).toBe("low");
  });

  it("should return low category for small impact", () => {
    const result = computeRiskScore(
      makeInputs({ affectedFileCount: 5, totalAffectedFileCount: 5 }),
    );
    expect(result.score).toBeLessThan(0.3);
    expect(result.category).toBe("low");
  });

  it("should return medium category for moderate impact", () => {
    const result = computeRiskScore(
      makeInputs({
        affectedFileCount: 30,
        publicApiBreakCount: 1,
        affectedPackageCount: 2,
        untestedAffectedFileCount: 10,
        totalAffectedFileCount: 30,
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(0.3);
    expect(result.score).toBeLessThan(0.6);
    expect(result.category).toBe("medium");
  });

  it("should return high category for large impact", () => {
    const result = computeRiskScore(
      makeInputs({
        affectedFileCount: 60,
        publicApiBreakCount: 2,
        affectedPackageCount: 3,
        untestedAffectedFileCount: 40,
        totalAffectedFileCount: 60,
        boundaryProximity: 0.5,
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(0.6);
    expect(result.score).toBeLessThan(0.8);
    expect(result.category).toBe("high");
  });

  it("should return critical category for maximum impact", () => {
    const result = computeRiskScore(
      makeInputs({
        affectedFileCount: 100,
        publicApiBreakCount: 5,
        affectedPackageCount: 5,
        untestedAffectedFileCount: 100,
        totalAffectedFileCount: 100,
        boundaryProximity: 1.0,
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(0.8);
    expect(result.category).toBe("critical");
  });

  it("should cap public API break contribution at 1.0", () => {
    const result3 = computeRiskScore(makeInputs({ publicApiBreakCount: 3 }));
    const result10 = computeRiskScore(makeInputs({ publicApiBreakCount: 10 }));
    expect(result3.score).toBe(result10.score);
  });

  it("should clamp boundary proximity to [0, 1]", () => {
    const resultHigh = computeRiskScore(makeInputs({ boundaryProximity: 5.0 }));
    const resultOne = computeRiskScore(makeInputs({ boundaryProximity: 1.0 }));
    expect(resultHigh.score).toBe(resultOne.score);

    const resultLow = computeRiskScore(makeInputs({ boundaryProximity: -1.0 }));
    const resultZero = computeRiskScore(makeInputs({ boundaryProximity: 0 }));
    expect(resultLow.score).toBe(resultZero.score);
  });

  it("should handle zero totalFileCount without division error", () => {
    const result = computeRiskScore(
      makeInputs({ totalFileCount: 0, affectedFileCount: 5 }),
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("should handle zero totalPackageCount without division error", () => {
    const result = computeRiskScore(
      makeInputs({ totalPackageCount: 0, affectedPackageCount: 2 }),
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("should handle zero totalAffectedFileCount without division error", () => {
    const result = computeRiskScore(
      makeInputs({ totalAffectedFileCount: 0, untestedAffectedFileCount: 3 }),
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("should produce scores between 0 and 1 inclusive", () => {
    const extremeHigh = computeRiskScore(
      makeInputs({
        affectedFileCount: 200,
        totalFileCount: 100,
        publicApiBreakCount: 100,
        affectedPackageCount: 20,
        totalPackageCount: 5,
        untestedAffectedFileCount: 200,
        totalAffectedFileCount: 100,
        boundaryProximity: 10,
      }),
    );
    expect(extremeHigh.score).toBeLessThanOrEqual(1);
    expect(extremeHigh.score).toBeGreaterThanOrEqual(0);
  });

  it("should weight public API breaks most heavily", () => {
    const apiOnly = computeRiskScore(makeInputs({ publicApiBreakCount: 3 }));
    const filesOnly = computeRiskScore(
      makeInputs({ affectedFileCount: 25 }),
    );
    // publicApiBreak weight (0.30) × 1.0 = 0.30
    // fileSpread weight (0.25) × 0.25 = 0.0625
    expect(apiOnly.score).toBeGreaterThan(filesOnly.score);
  });

  it("should round score to 3 decimal places", () => {
    const result = computeRiskScore(
      makeInputs({ affectedFileCount: 33, publicApiBreakCount: 1 }),
    );
    const decimals = result.score.toString().split(".")[1];
    expect(!decimals || decimals.length <= 3).toBe(true);
  });

  it("should always include breakdown in result", () => {
    const result = computeRiskScore(makeInputs());
    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.fileSpread).toBe(0);
    expect(result.breakdown.publicApiBreak).toBe(0);
    expect(result.breakdown.packageSpread).toBe(0);
    expect(result.breakdown.testGap).toBe(0);
    expect(result.breakdown.boundary).toBe(0);
  });

  it("should have all breakdown values in 0.0-1.0 range", () => {
    const result = computeRiskScore(
      makeInputs({
        affectedFileCount: 200,
        totalFileCount: 100,
        publicApiBreakCount: 100,
        affectedPackageCount: 20,
        totalPackageCount: 5,
        untestedAffectedFileCount: 200,
        totalAffectedFileCount: 100,
        boundaryProximity: 10,
      }),
    );
    for (const value of Object.values(result.breakdown)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("should have weighted breakdown sum match score", () => {
    const result = computeRiskScore(
      makeInputs({
        affectedFileCount: 30,
        publicApiBreakCount: 1,
        affectedPackageCount: 2,
        untestedAffectedFileCount: 10,
        totalAffectedFileCount: 30,
        boundaryProximity: 0.5,
      }),
    );
    const { breakdown } = result;
    const weightedSum =
      0.25 * breakdown.fileSpread +
      0.30 * breakdown.publicApiBreak +
      0.15 * breakdown.packageSpread +
      0.20 * breakdown.testGap +
      0.10 * breakdown.boundary;
    // Allow small floating-point rounding difference
    expect(Math.abs(result.score - Math.round(weightedSum * 1000) / 1000)).toBeLessThanOrEqual(0.001);
  });
});
