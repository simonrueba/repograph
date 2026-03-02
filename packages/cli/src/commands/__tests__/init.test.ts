import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
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

describe("init command", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ariadne-init-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should create .ariadne directory with index.db", { timeout: 30_000 }, () => {
    const raw = run(`init ${testDir}`, testDir);
    const envelope = JSON.parse(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("init");
    expect(existsSync(join(testDir, ".ariadne"))).toBe(true);
    expect(existsSync(join(testDir, ".ariadne", "index.db"))).toBe(true);
  });

  it("should create state.json with version and repoRoot", { timeout: 30_000 }, () => {
    run(`init ${testDir}`, testDir);
    const state = JSON.parse(readFileSync(join(testDir, ".ariadne", "state.json"), "utf-8"));
    expect(state.version).toBe(1);
    expect(state.repoRoot).toBe(testDir);
    expect(state.createdAt).toBeDefined();
  });

  it("should create .gitignore with .ariadne/ entry", { timeout: 30_000 }, () => {
    run(`init ${testDir}`, testDir);
    const gitignore = readFileSync(join(testDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".ariadne/");
  });

  it("should not duplicate .ariadne/ in existing .gitignore", { timeout: 30_000 }, () => {
    const gitignorePath = join(testDir, ".gitignore");
    const { writeFileSync } = require("fs");
    writeFileSync(gitignorePath, "node_modules/\n.ariadne/\n");
    run(`init ${testDir}`, testDir);
    const content = readFileSync(gitignorePath, "utf-8");
    const matches = content.match(/\.ariadne\//g);
    expect(matches).toHaveLength(1);
  });

  it("should create hooks.json and mcp.json", { timeout: 30_000 }, () => {
    run(`init ${testDir}`, testDir);
    expect(existsSync(join(testDir, ".ariadne", "hooks.json"))).toBe(true);
    expect(existsSync(join(testDir, ".ariadne", "mcp.json"))).toBe(true);
  });

  it("should be idempotent (run twice without error)", { timeout: 30_000 }, () => {
    run(`init ${testDir}`, testDir);
    const raw = run(`init ${testDir}`, testDir);
    const envelope = JSON.parse(raw);
    expect(envelope.ok).toBe(true);
  });
});
