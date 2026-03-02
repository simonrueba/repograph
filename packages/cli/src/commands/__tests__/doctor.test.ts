import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const CLI = join(__dirname, "..", "..", "..", "src", "index.ts");

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

describe("doctor command", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ariadne-doctor-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should return doctor output with checks array", { timeout: 60_000 }, () => {
    const { stdout } = runRaw(`doctor ${testDir}`, testDir);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("doctor");
    expect(Array.isArray(envelope.data.checks)).toBe(true);
    expect(envelope.data.checks.length).toBeGreaterThan(0);
  });

  it("should include bun_version check as ok", { timeout: 60_000 }, () => {
    const { stdout } = runRaw(`doctor ${testDir}`, testDir);
    const envelope = JSON.parse(stdout);
    const bunCheck = envelope.data.checks.find((c: any) => c.name === "bun_version");
    expect(bunCheck).toBeDefined();
    expect(bunCheck.status).toBe("ok");
  });

  it("should warn about missing index.db when not initialized", { timeout: 60_000 }, () => {
    const { stdout } = runRaw(`doctor ${testDir}`, testDir);
    const envelope = JSON.parse(stdout);
    const dbCheck = envelope.data.checks.find((c: any) => c.name === "index_db");
    expect(dbCheck).toBeDefined();
    expect(dbCheck.status).toBe("warn");
  });

  it("should show index_db as ok after init", { timeout: 60_000 }, () => {
    // Initialize first
    execSync(`bun run ${CLI} init ${testDir}`, {
      cwd: testDir,
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    const { stdout } = runRaw(`doctor ${testDir}`, testDir);
    const envelope = JSON.parse(stdout);
    const dbCheck = envelope.data.checks.find((c: any) => c.name === "index_db");
    expect(dbCheck.status).toBe("ok");
  });

  it("should report allOk as false when checks have warnings", { timeout: 60_000 }, () => {
    const { stdout, exitCode } = runRaw(`doctor ${testDir}`, testDir);
    const envelope = JSON.parse(stdout);
    // Without init, at least index_db and write_permission will warn
    expect(envelope.data.allOk).toBe(false);
    expect(exitCode).toBe(1);
  });
});
