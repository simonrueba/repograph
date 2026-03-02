import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const CLI = join(__dirname, "..", "..", "..", "src", "index.ts");

function run(command: string, cwd: string): string {
  return execSync(`bun run ${CLI} ${command}`, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, NODE_ENV: "test" },
  }).trim();
}

describe("setup --preset", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ariadne-preset-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should write ariadne.policies.json with default preset", { timeout: 30_000 }, () => {
    run(`setup --preset default --quick ${testDir}`, testDir);

    const policiesPath = join(testDir, "ariadne.policies.json");
    expect(existsSync(policiesPath)).toBe(true);

    const content = JSON.parse(readFileSync(policiesPath, "utf-8"));
    expect(content.policies.deny_new_cycles).toBe(true);
    expect(content.policies.max_public_api_growth).toBe(10);
    expect(content.policies.max_coupling_increase).toBe(5);
    expect(content._preset).toBe("default");
    expect(content._presetVersion).toBeDefined();
  });

  it("should write monorepo-strict preset", { timeout: 30_000 }, () => {
    run(`setup --preset monorepo-strict --quick ${testDir}`, testDir);

    const content = JSON.parse(readFileSync(join(testDir, "ariadne.policies.json"), "utf-8"));
    expect(content.policies.max_public_api_growth).toBe(3);
    expect(content.policies.max_coupling_increase).toBe(2);
    expect(content._preset).toBe("monorepo-strict");
  });

  it("should not overwrite existing policies file", { timeout: 30_000 }, () => {
    const policiesPath = join(testDir, "ariadne.policies.json");
    writeFileSync(policiesPath, JSON.stringify({ policies: { custom: true } }));

    const output = run(`setup --preset default --quick ${testDir}`, testDir);
    const envelope = JSON.parse(output.split("\n").filter(l => l.includes('"setup"')).pop()!);

    const presetStep = envelope.data.steps.find((s: any) => s.step === "policy_preset");
    expect(presetStep.status).toBe("exists");

    // Original file should be untouched
    const content = JSON.parse(readFileSync(policiesPath, "utf-8"));
    expect(content.policies.custom).toBe(true);
  });

  it("should report unknown preset name", { timeout: 30_000 }, () => {
    const output = run(`setup --preset bogus --quick ${testDir}`, testDir);
    const envelope = JSON.parse(output.split("\n").filter(l => l.includes('"setup"')).pop()!);

    const presetStep = envelope.data.steps.find((s: any) => s.step === "policy_preset");
    expect(presetStep.status).toContain("unknown preset");
  });

  it("should not write policies when no --preset flag", { timeout: 30_000 }, () => {
    run(`setup --quick ${testDir}`, testDir);

    expect(existsSync(join(testDir, "ariadne.policies.json"))).toBe(false);
  });
});
