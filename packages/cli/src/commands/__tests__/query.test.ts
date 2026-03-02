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

function runRaw(command: string, cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`bun run ${CLI} ${command}`, {
      cwd,
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, NODE_ENV: "test" },
    }).trim();
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout ?? "").trim(), exitCode: err.status ?? 1 };
  }
}

describe("query command", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "ariadne-query-test-"));

    writeFileSync(
      join(testDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler" },
        include: ["src"],
      }),
    );

    mkdirSync(join(testDir, "src"));
    writeFileSync(join(testDir, "src", "core.ts"), `export function compute(x: number): number { return x * 2; }\nexport const PI = 3.14;\n`);
    writeFileSync(join(testDir, "src", "service.ts"), `import { compute } from "./core";\nexport const result = compute(5);\n`);
    writeFileSync(join(testDir, "src", "app.ts"), `import { result } from "./service";\nconsole.log(result);\n`);

    // Setup and index
    run(`setup --quick ${testDir}`, testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should return search results for a symbol name", { timeout: 60_000 }, () => {
    const raw = run(`query search compute --root ${testDir}`, testDir);
    const envelope = JSON.parse(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("query.search");
    expect(Array.isArray(envelope.data.results)).toBe(true);
  });

  it("should return impact for a file", { timeout: 60_000 }, () => {
    const raw = run(`query impact src/core.ts --root ${testDir}`, testDir);
    const envelope = JSON.parse(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("query.impact");
    expect(envelope.data.result).toBeDefined();
    // service.ts imports core.ts, so it should be in dependents
    const deps = envelope.data.result.dependentFiles ?? [];
    const paths = deps.map((d: any) => d.path ?? d);
    expect(paths.some((p: string) => p.includes("service"))).toBe(true);
  });

  it("should return module-graph", { timeout: 60_000 }, () => {
    const raw = run(`query module-graph --root ${testDir}`, testDir);
    const envelope = JSON.parse(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("query.module-graph");
    expect(envelope.data.result).toBeDefined();
    expect(envelope.data.result.nodes).toBeDefined();
    expect(envelope.data.result.edges).toBeDefined();
  });

  it("should error on missing subcommand argument", { timeout: 60_000 }, () => {
    const { stdout } = runRaw(`query search --root ${testDir}`, testDir);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(false);
  });

  it("should error on unknown subcommand", { timeout: 60_000 }, () => {
    const { stdout } = runRaw(`query bogus --root ${testDir}`, testDir);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("UNKNOWN_SUBCOMMAND");
  });
});
