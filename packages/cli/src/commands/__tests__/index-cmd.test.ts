import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

describe("index command", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ariadne-index-test-"));

    writeFileSync(
      join(testDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler" },
        include: ["src"],
      }),
    );

    mkdirSync(join(testDir, "src"));
    writeFileSync(join(testDir, "src", "a.ts"), `export function greet(): string { return "hello"; }\n`);
    writeFileSync(join(testDir, "src", "b.ts"), `import { greet } from "./a";\nconsole.log(greet());\n`);

    // Init first
    run(`init ${testDir}`, testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should index source files and return file count", { timeout: 60_000 }, () => {
    const raw = run(`index --structural-only ${testDir}`, testDir);
    const envelope = JSON.parse(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("index");
    expect(envelope.data.fileCount).toBeGreaterThanOrEqual(2);
  });

  it("should detect structural imports between files", { timeout: 60_000 }, () => {
    run(`index --structural-only ${testDir}`, testDir);
    // Verify via query that b.ts depends on a.ts
    const raw = run(`query impact src/a.ts --root ${testDir}`, testDir);
    const envelope = JSON.parse(raw);
    const deps = envelope.data.result.dependentFiles ?? [];
    const paths = deps.map((d: any) => d.path ?? d);
    expect(paths.some((p: string) => p.includes("b.ts"))).toBe(true);
  });

  it("should be re-runnable (idempotent)", { timeout: 60_000 }, () => {
    run(`index --structural-only ${testDir}`, testDir);
    const raw = run(`index --structural-only ${testDir}`, testDir);
    const envelope = JSON.parse(raw);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.fileCount).toBeGreaterThanOrEqual(2);
  });

  it("should pick up new files on re-index", { timeout: 60_000 }, () => {
    run(`index --structural-only ${testDir}`, testDir);

    // Add a new file
    writeFileSync(join(testDir, "src", "c.ts"), `import { greet } from "./a";\nexport const x = greet();\n`);

    const raw = run(`index --structural-only ${testDir}`, testDir);
    const envelope = JSON.parse(raw);
    expect(envelope.data.fileCount).toBeGreaterThanOrEqual(3);
  });
});
