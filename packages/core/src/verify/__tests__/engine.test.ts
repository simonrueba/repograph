import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type RepographDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { Ledger } from "../../ledger/ledger";
import { VerifyEngine, type VerifyReport } from "../engine";
import { checkIndexFreshness } from "../checks/index-freshness";
import { checkMissingTests } from "../checks/missing-tests";
import { checkTypecheck } from "../checks/typecheck";

describe("VerifyEngine", () => {
  let db: RepographDB;
  let queries: StoreQueries;
  let ledger: Ledger;
  let repoRoot: string;
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "repograph-verify-test-"));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    repoRoot = makeTempDir();
    mkdirSync(join(repoRoot, ".repograph"), { recursive: true });
    db = createDatabase(join(repoRoot, ".repograph", "index.db"));
    queries = new StoreQueries(db);
    ledger = new Ledger(db);
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  // ── Helper: create source files on disk ─────────────────────────────

  function writeSourceFile(relativePath: string, content: string): void {
    const fullPath = join(repoRoot, relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  function hashContent(content: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    return hasher.digest("hex");
  }

  // ── index-freshness check ───────────────────────────────────────────

  describe("checkIndexFreshness", () => {
    it("should pass when all indexed files match disk", () => {
      const content = "export function add(a: number, b: number) { return a + b; }";
      writeSourceFile("src/math.ts", content);
      queries.upsertFile({
        path: "src/math.ts",
        language: "typescript",
        hash: hashContent(content),
      });

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should fail when a file on disk has a different hash than indexed", () => {
      writeSourceFile("src/math.ts", "export function add() {}");
      queries.upsertFile({
        path: "src/math.ts",
        language: "typescript",
        hash: "stale-hash-from-previous-index",
      });

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].type).toBe("STALE_INDEX");
      expect(result.issues[0].path).toBe("src/math.ts");
    });

    it("should detect new files not yet indexed", () => {
      writeSourceFile("src/new-file.ts", "export const x = 1;");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(false);
      expect(result.issues.some((i) => i.path === "src/new-file.ts")).toBe(true);
    });

    it("should skip non-source files", () => {
      writeSourceFile("README.md", "# Hello");
      writeSourceFile("data.json", "{}");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should skip node_modules and dotfile directories", () => {
      writeSourceFile("node_modules/lib/index.ts", "export const x = 1;");
      writeSourceFile(".git/hooks/pre-commit.js", "#!/usr/bin/env node");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  // ── missing-tests check ─────────────────────────────────────────────

  describe("checkMissingTests", () => {
    it("should fail when ledger has edit but no test_run after it", () => {
      ledger.log("edit", { file: "src/main.ts" });

      const result = checkMissingTests(ledger);
      expect(result.passed).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe("MISSING_TEST_RUN");
    });

    it("should pass when test ran after last edit", () => {
      ledger.log("edit", { file: "src/main.ts" });
      ledger.log("test_run", { command: "vitest run" });

      const result = checkMissingTests(ledger);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should pass when no edits exist", () => {
      const result = checkMissingTests(ledger);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should fail when edit happened after test_run", () => {
      ledger.log("edit", { file: "a.ts" });
      ledger.log("test_run", { command: "vitest" });
      ledger.log("edit", { file: "b.ts" });

      const result = checkMissingTests(ledger);
      expect(result.passed).toBe(false);
      expect(result.issues[0].type).toBe("MISSING_TEST_RUN");
    });
  });

  // ── typecheck check ─────────────────────────────────────────────────

  describe("checkTypecheck", () => {
    it("should pass when no tsconfig.json exists", () => {
      const result = checkTypecheck(repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should pass for valid TypeScript", () => {
      writeSourceFile("tsconfig.json", JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
        include: ["src"],
      }));
      writeSourceFile("src/valid.ts", "export const x: number = 1;");

      const result = checkTypecheck(repoRoot);
      expect(result.passed).toBe(true);
    });

    it("should fail for invalid TypeScript", () => {
      writeSourceFile("tsconfig.json", JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
        include: ["src"],
      }));
      writeSourceFile("src/invalid.ts", "export const x: number = 'not a number';");

      const result = checkTypecheck(repoRoot);
      expect(result.passed).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].type).toBe("TYPE_ERROR");
    });
  });

  // ── Full engine ─────────────────────────────────────────────────────

  describe("VerifyEngine.verify()", () => {
    it("should return OK when all checks pass", () => {
      const content = "export const x = 1;";
      writeSourceFile("src/index.ts", content);
      queries.upsertFile({
        path: "src/index.ts",
        language: "typescript",
        hash: hashContent(content),
      });
      // No edits logged, so test coverage passes
      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = engine.verify();

      expect(report.status).toBe("OK");
      expect(report.checks.indexFreshness.passed).toBe(true);
      expect(report.checks.testCoverage.passed).toBe(true);
      expect(report.checks.typecheck.passed).toBe(true);
      expect(report.timestamp).toBeTypeOf("number");
    });

    it("should return FAIL when index is stale", () => {
      writeSourceFile("src/index.ts", "export const x = 2;");
      queries.upsertFile({
        path: "src/index.ts",
        language: "typescript",
        hash: "old-hash",
      });

      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = engine.verify();

      expect(report.status).toBe("FAIL");
      expect(report.checks.indexFreshness.passed).toBe(false);
    });

    it("should return FAIL when tests are missing after edit", () => {
      ledger.log("edit", { file: "src/main.ts" });

      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = engine.verify();

      expect(report.status).toBe("FAIL");
      expect(report.checks.testCoverage.passed).toBe(false);
    });

    it("should include summary listing failed check names", () => {
      writeSourceFile("src/index.ts", "export const x = 2;");
      queries.upsertFile({
        path: "src/index.ts",
        language: "typescript",
        hash: "old-hash",
      });
      ledger.log("edit", { file: "src/main.ts" });

      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = engine.verify();

      expect(report.status).toBe("FAIL");
      expect(report.summary).toContain("indexFreshness");
      expect(report.summary).toContain("testCoverage");
    });

    it("should return structured report shape", () => {
      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = engine.verify();

      expect(report).toHaveProperty("status");
      expect(report).toHaveProperty("timestamp");
      expect(report).toHaveProperty("checks");
      expect(report).toHaveProperty("summary");
      expect(report.checks).toHaveProperty("indexFreshness");
      expect(report.checks).toHaveProperty("testCoverage");
      expect(report.checks).toHaveProperty("typecheck");
    });
  });
});
