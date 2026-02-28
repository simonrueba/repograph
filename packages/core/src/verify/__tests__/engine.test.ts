import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type AriadneDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { Ledger } from "../../ledger/ledger";
import { VerifyEngine, type VerifyReport } from "../engine";
import { checkIndexFreshness } from "../checks/index-freshness";
import { checkMissingTests } from "../checks/missing-tests";
import { checkTypecheck } from "../checks/typecheck";

describe("VerifyEngine", () => {
  let db: AriadneDB;
  let queries: StoreQueries;
  let ledger: Ledger;
  let repoRoot: string;
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-verify-test-"));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    repoRoot = makeTempDir();
    mkdirSync(join(repoRoot, ".ariadne"), { recursive: true });
    db = createDatabase(join(repoRoot, ".ariadne", "index.db"));
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

  // ── index-freshness check ───────────────────────────────────────────

  describe("checkIndexFreshness", () => {
    it("should pass when dirty set is empty", () => {
      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should fail when dirty set has entries and no full index ran", () => {
      queries.markDirty("src/math.ts");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].type).toBe("INDEX_STALE");
      expect(result.issues[0].path).toBe("src/math.ts");
    });

    it("should pass when full index timestamp covers dirty entries", () => {
      queries.markDirty("src/math.ts");
      // Simulate a full index that happened after the dirty entry
      queries.setMeta("last_full_scip_index_ts", String(Date.now() + 1000));

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should fail when dirty entry is newer than last full index", () => {
      queries.setMeta("last_full_scip_index_ts", String(Date.now() - 10000));
      queries.markDirty("src/new-file.ts");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(false);
      expect(result.issues.some((i) => i.path === "src/new-file.ts")).toBe(true);
    });

    it("should pass when only non-source files are dirty", () => {
      queries.markDirty("README.md");
      queries.markDirty("package.json");
      queries.markDirty("docs/guide.txt");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should only report stale source files when mixed with non-source", () => {
      queries.markDirty("README.md");
      queries.markDirty("src/app.ts");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].path).toBe("src/app.ts");
    });

    // ── source extension coverage ──────────────────────────────────────

    it.each([
      ["src/index.ts"],
      ["src/component.tsx"],
      ["lib/utils.js"],
      ["lib/button.jsx"],
      ["scripts/run.py"],
    ])("should treat %s as a source file (stale when dirty)", (filePath) => {
      queries.markDirty(filePath);

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].path).toBe(filePath);
    });

    it.each([
      ["README.md"],
      ["package.json"],
      [".env"],
      ["tsconfig.json"],
      ["styles/app.css"],
      ["index.html"],
      ["config.yaml"],
    ])("should treat %s as non-source (ignored when dirty)", (filePath) => {
      queries.markDirty(filePath);

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    // ── tricky extension edge cases ────────────────────────────────────

    it("should ignore files with no extension", () => {
      queries.markDirty("Makefile");
      queries.markDirty("Dockerfile");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should ignore files with misleading double extensions", () => {
      queries.markDirty("src/index.ts.bak");
      queries.markDirty("src/bundle.js.map");
      queries.markDirty("src/types.d.ts.old");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should treat dotfiles with source extensions as source", () => {
      queries.markDirty(".eslintrc.js");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].path).toBe(".eslintrc.js");
    });

    // ── timestamp boundary interactions with filtering ─────────────────

    it("should pass when non-source files are dirty with stale SCIP timestamp", () => {
      // SCIP timestamp is old, but only non-source files are dirty — should still pass
      queries.setMeta("last_full_scip_index_ts", String(Date.now() - 100000));
      queries.markDirty("README.md");
      queries.markDirty("package.json");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should pass when SCIP timestamp exactly equals newest dirty timestamp", () => {
      queries.markDirty("src/exact.ts");
      const dirtyTs = queries.getDirtyPaths()[0].changed_at;
      queries.setMeta("last_full_scip_index_ts", String(dirtyTs));

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should only report source files newer than SCIP timestamp in mixed set", () => {
      // Old SCIP timestamp
      queries.setMeta("last_full_scip_index_ts", String(Date.now() - 50000));

      // Mark a source file dirty (will be newer than SCIP ts)
      queries.markDirty("src/stale.ts");
      // Mark non-source files dirty (should be ignored regardless)
      queries.markDirty("README.md");
      queries.markDirty("package.json");

      const result = checkIndexFreshness(queries, repoRoot);
      expect(result.passed).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].path).toBe("src/stale.ts");
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

    it("should pass for valid TypeScript", { timeout: 30_000 }, () => {
      writeSourceFile("tsconfig.json", JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
        include: ["src"],
      }));
      writeSourceFile("src/valid.ts", "export const x: number = 1;");

      const result = checkTypecheck(repoRoot);
      expect(result.passed).toBe(true);
    });

    it("should fail for invalid TypeScript", { timeout: 30_000 }, () => {
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
    it("should return FAIL when index is empty (no files indexed)", async () => {
      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = await engine.verify();

      expect(report.status).toBe("FAIL");
      expect(report.checks.indexFreshness.passed).toBe(false);
      expect(report.summary).toContain("indexFreshness");
    });

    it("should return OK when all checks pass", async () => {
      // Insert a file so the index is non-empty
      queries.upsertFile({ path: "src/app.ts", language: "typescript", hash: "abc123" });

      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = await engine.verify();

      expect(report.status).toBe("OK");
      expect(report.checks.indexFreshness.passed).toBe(true);
      expect(report.checks.testCoverage.passed).toBe(true);
      expect(report.checks.typecheck.passed).toBe(true);
      expect(report.timestamp).toBeTypeOf("number");
    });

    it("should return FAIL when index is stale", async () => {
      queries.upsertFile({ path: "src/index.ts", language: "typescript", hash: "abc" });
      queries.markDirty("src/index.ts");

      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = await engine.verify();

      expect(report.status).toBe("FAIL");
      expect(report.checks.indexFreshness.passed).toBe(false);
    });

    it("should return FAIL when tests are missing after edit", async () => {
      queries.upsertFile({ path: "src/main.ts", language: "typescript", hash: "abc" });
      ledger.log("edit", { file: "src/main.ts" });

      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = await engine.verify();

      expect(report.status).toBe("FAIL");
      expect(report.checks.testCoverage.passed).toBe(false);
    });

    it("should include summary listing failed check names", async () => {
      queries.upsertFile({ path: "src/index.ts", language: "typescript", hash: "abc" });
      queries.markDirty("src/index.ts");
      ledger.log("edit", { file: "src/main.ts" });

      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = await engine.verify();

      expect(report.status).toBe("FAIL");
      expect(report.summary).toContain("indexFreshness");
      expect(report.summary).toContain("testCoverage");
    });

    it("should return OK when only non-source files are dirty", async () => {
      queries.upsertFile({ path: "src/app.ts", language: "typescript", hash: "abc123" });
      queries.markDirty("README.md");
      queries.markDirty("package.json");

      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = await engine.verify();

      expect(report.status).toBe("OK");
      expect(report.checks.indexFreshness.passed).toBe(true);
    });

    it("should return structured report shape", async () => {
      queries.upsertFile({ path: "src/app.ts", language: "typescript", hash: "abc" });

      const engine = new VerifyEngine(queries, ledger, repoRoot);
      const report = await engine.verify();

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
