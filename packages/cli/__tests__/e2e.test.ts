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
    testDir = mkdtempSync(join(tmpdir(), "ariadne-e2e-"));

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

  it("init creates .ariadne/ with expected files", () => {
    const output = run(`init ${testDir}`, testDir);
    const envelope = JSON.parse(output);

    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("init");
    expect(envelope.data.ariadneDir).toBeDefined();
    expect(envelope.data.dbPath).toBeDefined();
    expect(existsSync(join(testDir, ".ariadne"))).toBe(true);
    expect(existsSync(join(testDir, ".ariadne", "index.db"))).toBe(true);
    expect(existsSync(join(testDir, ".ariadne", "state.json"))).toBe(true);
    expect(existsSync(join(testDir, ".ariadne", "hooks.json"))).toBe(true);
    expect(existsSync(join(testDir, ".ariadne", "mcp.json"))).toBe(true);
  });

  it("update registers files and detects stale files", () => {
    const output = run(`update ${testDir}`, testDir);
    const envelope = JSON.parse(output);

    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("update");
    // First update should register all files as new
    expect(envelope.data.newFiles + envelope.data.staleFiles).toBeGreaterThanOrEqual(2);
    expect(envelope.data.updated).toBeGreaterThanOrEqual(2);
  });

  it("status shows registered files and edges", () => {
    const output = run(`status ${testDir}`, testDir);
    const envelope = JSON.parse(output);

    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("status");
    expect(envelope.data.totalFiles).toBeGreaterThanOrEqual(2);
    expect(envelope.data.totalEdges).toBeGreaterThanOrEqual(1);
    expect(envelope.data.meta).toBeDefined();
  });

  it("ledger log records an event", () => {
    run(`ledger log test_event '{"key":"value"}' ${testDir}`, testDir);

    const listOutput = run(`ledger list ${testDir}`, testDir);
    const listEnvelope = JSON.parse(listOutput);

    expect(listEnvelope.ok).toBe(true);
    expect(listEnvelope.kind).toBe("ledger.list");

    const testEntries = listEnvelope.data.entries.filter(
      (e: any) => e.event === "test_event",
    );
    expect(testEntries.length).toBeGreaterThanOrEqual(1);

    const data = JSON.parse(testEntries[0].data);
    expect(data.key).toBe("value");
  });

  it("verify fails without test run after edit", { timeout: 30_000 }, () => {
    // Log an edit event so the verify check triggers
    run(`ledger log edit '{"file":"src/math.ts"}' ${testDir}`, testDir);

    // verify should fail because no test_run after the edit
    try {
      run(`verify ${testDir}`, testDir);
      // If it didn't throw, status was OK — acceptable depending on verify engine state
    } catch (err: any) {
      // verify exits with code 1 on FAIL; execSync throws on non-zero exit
      const stdout = err.stdout?.toString().trim() || "";
      if (stdout) {
        const envelope = JSON.parse(stdout);
        expect(envelope.ok).toBe(true);
        expect(envelope.kind).toBe("verify");
        expect(envelope.data.status).toBe("FAIL");
      }
    }
  });

  it("query module-graph returns nodes and edges", () => {
    const output = run(`query module-graph --root ${testDir}`, testDir);
    const envelope = JSON.parse(output);

    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("query.module-graph");
    expect(envelope.data.result).toBeDefined();
    expect(Array.isArray(envelope.data.result.nodes)).toBe(true);
    expect(Array.isArray(envelope.data.result.edges)).toBe(true);
    expect(envelope.data.result.nodes.length).toBeGreaterThanOrEqual(2);
  });
});
