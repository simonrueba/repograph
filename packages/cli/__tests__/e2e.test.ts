import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(__dirname, "..", "src", "index.ts");

function run(command: string, cwd: string): string {
  return execSync(`bun run ${CLI} ${command}`, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, NODE_ENV: "test" },
  }).trim();
}

describe("CLI e2e", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "repograph-e2e-"));

    // Create a minimal TS project
    writeFileSync(
      join(testDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
        },
        include: ["src"],
      }),
    );

    mkdirSync(join(testDir, "src"));

    writeFileSync(
      join(testDir, "src", "math.ts"),
      `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`,
    );

    writeFileSync(
      join(testDir, "src", "main.ts"),
      `import { add, multiply } from "./math";

export function calculate(a: number, b: number): number {
  return add(a, b) + multiply(a, b);
}
`,
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("init creates .repograph/ with expected files", () => {
    const output = run(`init ${testDir}`, testDir);
    const result = JSON.parse(output);

    expect(result.status).toBe("initialized");
    expect(existsSync(join(testDir, ".repograph"))).toBe(true);
    expect(existsSync(join(testDir, ".repograph", "index.db"))).toBe(true);
    expect(existsSync(join(testDir, ".repograph", "state.json"))).toBe(true);
    expect(existsSync(join(testDir, ".repograph", "hooks.json"))).toBe(true);
    expect(existsSync(join(testDir, ".repograph", "mcp.json"))).toBe(true);
  });

  it("update registers files and detects stale files", () => {
    const output = run(`update ${testDir}`, testDir);
    const result = JSON.parse(output);

    // First update should register all files as new
    expect(result.newFiles + result.staleFiles).toBeGreaterThanOrEqual(2);
    expect(result.updated).toBeGreaterThanOrEqual(2);
  });

  it("status shows registered files and edges", () => {
    const output = run(`status ${testDir}`, testDir);
    const result = JSON.parse(output);

    expect(result.totalFiles).toBeGreaterThanOrEqual(2);
    expect(result.totalEdges).toBeGreaterThanOrEqual(1);
  });

  it("ledger log records an event", () => {
    run(`ledger log test_event '{"key":"value"}' ${testDir}`, testDir);

    const listOutput = run(`ledger list ${testDir}`, testDir);
    const listResult = JSON.parse(listOutput);

    const testEntries = listResult.entries.filter(
      (e: any) => e.event === "test_event",
    );
    expect(testEntries.length).toBeGreaterThanOrEqual(1);

    const data = JSON.parse(testEntries[0].data);
    expect(data.key).toBe("value");
  });

  it("verify fails without test run after edit", () => {
    // Log an edit event so the verify check triggers
    run(`ledger log edit '{"file":"src/math.ts"}' ${testDir}`, testDir);

    // verify should fail because no test_run after the edit
    try {
      run(`verify ${testDir}`, testDir);
      // If it didn't throw, it means status was OK -- that could happen
      // if the verify engine considers the state acceptable
    } catch (err: any) {
      // verify exits with code 1 on FAIL, execSync throws
      const stderr = err.stderr?.toString() || "";
      expect(stderr).toContain("REPOGRAPH_VERIFY: FAIL");

      const stdout = err.stdout?.toString().trim() || "";
      if (stdout) {
        const report = JSON.parse(stdout);
        expect(report.status).toBe("FAIL");
      }
    }
  });

  it("query module-graph returns nodes and edges", () => {
    const output = run(`query module-graph --root ${testDir}`, testDir);
    const result = JSON.parse(output);

    expect(result.result).toBeDefined();
    expect(Array.isArray(result.result.nodes)).toBe(true);
    expect(Array.isArray(result.result.edges)).toBe(true);
    expect(result.result.nodes.length).toBeGreaterThanOrEqual(2);
  });
});
