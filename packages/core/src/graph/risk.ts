export interface RiskInputs {
  affectedFileCount: number;
  totalFileCount: number;
  publicApiBreakCount: number;
  affectedPackageCount: number;
  totalPackageCount: number;
  untestedAffectedFileCount: number;
  totalAffectedFileCount: number;
  boundaryProximity: number; // 0.0–1.0
}

export type RiskCategory = "low" | "medium" | "high" | "critical";

export interface RiskBreakdown {
  fileSpread: number;      // 0.0–1.0
  publicApiBreak: number;  // 0.0–1.0
  packageSpread: number;   // 0.0–1.0
  testGap: number;         // 0.0–1.0
  boundary: number;        // 0.0–1.0
}

export interface RiskResult {
  score: number;
  category: RiskCategory;
  breakdown: RiskBreakdown;
}

/**
 * Compute a risk score from impact analysis inputs.
 *
 * Weighted formula:
 *   file spread   (0.25) — fraction of affected files in repo
 *   public API    (0.30) — number of public API breaks (capped at 1.0)
 *   package spread(0.15) — fraction of affected packages
 *   test gap      (0.20) — fraction of affected files without tests
 *   boundary      (0.10) — proximity to architectural boundary (0–1)
 *
 * Categories:
 *   low      < 0.3
 *   medium   < 0.6
 *   high     < 0.8
 *   critical >= 0.8
 */
export function computeRiskScore(inputs: RiskInputs): RiskResult {
  const fileSpread =
    inputs.totalFileCount > 0
      ? inputs.affectedFileCount / inputs.totalFileCount
      : 0;

  const publicApiBreak = Math.min(inputs.publicApiBreakCount / 3, 1.0);

  const packageSpread =
    inputs.totalPackageCount > 0
      ? inputs.affectedPackageCount / inputs.totalPackageCount
      : 0;

  const testGap =
    inputs.totalAffectedFileCount > 0
      ? inputs.untestedAffectedFileCount / inputs.totalAffectedFileCount
      : 0;

  const boundary = Math.max(0, Math.min(1, inputs.boundaryProximity));

  const score =
    0.25 * fileSpread +
    0.30 * publicApiBreak +
    0.15 * packageSpread +
    0.20 * testGap +
    0.10 * boundary;

  const clamped = Math.max(0, Math.min(1, score));

  let category: RiskCategory;
  if (clamped < 0.3) category = "low";
  else if (clamped < 0.6) category = "medium";
  else if (clamped < 0.8) category = "high";
  else category = "critical";

  const clamp01 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;

  return {
    score: clamp01(clamped),
    category,
    breakdown: {
      fileSpread: clamp01(fileSpread),
      publicApiBreak: clamp01(publicApiBreak),
      packageSpread: clamp01(packageSpread),
      testGap: clamp01(testGap),
      boundary: clamp01(boundary),
    },
  };
}
