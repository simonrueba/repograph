import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const CLI = join(__dirname, "..", "..", "..", "src", "index.ts");

function run(command: string, cwd: string): string {
  return execSync(`bun run ${CLI} ${command}`, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, NODE_ENV: "test" },
  }).trim();
}

describe("ci report fields", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "ariadne-ci-fields-"));

    // Create a minimal TS project with git
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: testDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: testDir, stdio: "pipe" });

    writeFileSync(
      join(testDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler" },
        include: ["src"],
      }),
    );

    mkdirSync(join(testDir, "src"));
    writeFileSync(join(testDir, "src", "core.ts"), `export function compute(x: number): number { return x * 2; }\n`);
    writeFileSync(join(testDir, "src", "service.ts"), `import { compute } from "./core";\nexport const result = compute(5);\n`);

    // Initial commit on main
    execSync("git add -A && git commit -m 'init'", { cwd: testDir, stdio: "pipe" });

    // Setup ariadne index
    run(`setup --quick ${testDir}`, testDir);

    // Save metrics baseline
    run(`metrics --save ${testDir}`, testDir);

    // Create a branch with changes
    execSync("git checkout -b feature", { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, "src", "core.ts"), `export function compute(x: number): number { return x * 3; }\nexport function newFn(): void {}\n`);
    execSync("git add -A && git commit -m 'change core'", { cwd: testDir, stdio: "pipe" });

    // Re-index to pick up changes
    run(`index ${testDir}`, testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should include all new CiReport fields", { timeout: 60_000 }, () => {
    const raw = run(`ci --base main --root ${testDir}`, testDir);
    const envelope = JSON.parse(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("ci_report");

    const report = envelope.data;

    // Original fields still present
    expect(report.changedFiles).toBeDefined();
    expect(report.impact).toBeDefined();
    expect(report.verify).toBeDefined();
    expect(report.metrics).toBeDefined();
    expect(report.summary).toBeDefined();
    expect(report.markdown).toBeDefined();
    expect(report.impact.topAffectedFiles).toBeDefined();

    // NEW fields
    expect(report.allAffectedFiles).toBeDefined();
    expect(Array.isArray(report.allAffectedFiles)).toBe(true);

    expect(report.changedSymbols).toBeDefined();
    expect(Array.isArray(report.changedSymbols)).toBe(true);

    expect(report.publicApiBreakDetails).toBeDefined();
    expect(Array.isArray(report.publicApiBreakDetails)).toBe(true);

    expect(report.affectedPackages).toBeDefined();
    expect(Array.isArray(report.affectedPackages)).toBe(true);

    expect(report.boundaryViolationRisk).toBeDefined();
    expect(["none", "low", "medium", "high"]).toContain(report.boundaryViolationRisk);

    expect(report.testFiles).toBeDefined();
    expect(Array.isArray(report.testFiles)).toBe(true);

    expect(report.riskBreakdown).toBeDefined();
    expect(typeof report.riskBreakdown.fileSpread).toBe("number");
    expect(typeof report.riskBreakdown.publicApiBreak).toBe("number");
    expect(typeof report.riskBreakdown.packageSpread).toBe("number");
    expect(typeof report.riskBreakdown.testGap).toBe("number");
    expect(typeof report.riskBreakdown.boundary).toBe("number");

    expect(report.recommendations).toBeDefined();
    expect(Array.isArray(report.recommendations)).toBe(true);
  });

  it("should populate changedSymbols array (may be empty with --quick structural-only index)", { timeout: 60_000 }, () => {
    const raw = run(`ci --base main --root ${testDir}`, testDir);
    const report = JSON.parse(raw).data;

    // With --quick (structural-only), SCIP symbols may not be indexed.
    // The field must exist and be an array regardless.
    expect(Array.isArray(report.changedSymbols)).toBe(true);
    for (const s of report.changedSymbols) {
      expect(s).toHaveProperty("id");
      expect(s).toHaveProperty("name");
      expect(s).toHaveProperty("filePath");
      expect(s).toHaveProperty("isPublicApi");
    }
  });

  it("should have allAffectedFiles be a superset of topAffectedFiles", { timeout: 60_000 }, () => {
    const raw = run(`ci --base main --root ${testDir}`, testDir);
    const report = JSON.parse(raw).data;

    expect(report.allAffectedFiles.length).toBeGreaterThanOrEqual(report.impact.topAffectedFiles.length);
    const allPaths = new Set(report.allAffectedFiles.map((f: any) => f.path));
    for (const f of report.impact.topAffectedFiles) {
      expect(allPaths.has(f.path)).toBe(true);
    }
  });

  it("should find service.ts in affected files (imports core.ts)", { timeout: 60_000 }, () => {
    const raw = run(`ci --base main --root ${testDir}`, testDir);
    const report = JSON.parse(raw).data;

    const paths = report.allAffectedFiles.map((f: any) => f.path);
    expect(paths).toContain("src/service.ts");
  });

  it("should produce valid markdown with Ariadne Structural Report marker", { timeout: 60_000 }, () => {
    const raw = run(`ci --base main --root ${testDir}`, testDir);
    const report = JSON.parse(raw).data;

    expect(report.markdown).toContain("Ariadne Structural Report");
    expect(report.markdown).toContain("Risk Drivers");
  });
});
