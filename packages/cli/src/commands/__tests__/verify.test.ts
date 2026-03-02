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

describe("verify command", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "ariadne-verify-test-"));

    // Create a minimal TS project
    writeFileSync(
      join(testDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler" },
        include: ["src"],
      }),
    );

    mkdirSync(join(testDir, "src"));
    writeFileSync(join(testDir, "src", "a.ts"), `export function hello(): string { return "hi"; }\n`);
    writeFileSync(join(testDir, "src", "b.ts"), `import { hello } from "./a";\nexport const msg = hello();\n`);

    // Setup ariadne
    run(`setup --quick ${testDir}`, testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should return verify output with status", { timeout: 60_000 }, () => {
    const { stdout } = runRaw(`verify ${testDir}`, testDir);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("verify");
    expect(envelope.data.status).toBeDefined();
  });

  it("should pass verification on a clean project", { timeout: 60_000 }, () => {
    const { stdout, exitCode } = runRaw(`verify ${testDir}`, testDir);
    const envelope = JSON.parse(stdout);
    expect(envelope.data.status).toBe("OK");
    expect(exitCode).toBe(0);
  });

  it("should write verify_last.json to .ariadne dir", { timeout: 60_000 }, () => {
    runRaw(`verify ${testDir}`, testDir);
    const { existsSync, readFileSync } = require("fs");
    const reportPath = join(testDir, ".ariadne", "verify_last.json");
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(report.status).toBeDefined();
  });
});
