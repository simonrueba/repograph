import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ScipTypescriptIndexer } from "../scip-typescript";
import { ScipPythonIndexer } from "../scip-python";

describe("ScipTypescriptIndexer", () => {
  let indexer: ScipTypescriptIndexer;
  let tempDir: string;

  beforeEach(() => {
    indexer = new ScipTypescriptIndexer();
    tempDir = mkdtempSync(join(tmpdir(), "scip-ts-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("name", () => {
    it("should have a descriptive name", () => {
      expect(indexer.name).toBe("scip-typescript");
    });
  });

  describe("canIndex", () => {
    it("should return false for an empty directory", () => {
      expect(indexer.canIndex(tempDir)).toBe(false);
    });

    it("should return true when tsconfig.json exists", () => {
      writeFileSync(join(tempDir, "tsconfig.json"), "{}");
      expect(indexer.canIndex(tempDir)).toBe(true);
    });

    it("should return true when jsconfig.json exists", () => {
      writeFileSync(join(tempDir, "jsconfig.json"), "{}");
      expect(indexer.canIndex(tempDir)).toBe(true);
    });

    it("should return false when neither config exists", () => {
      writeFileSync(join(tempDir, "package.json"), "{}");
      expect(indexer.canIndex(tempDir)).toBe(false);
    });
  });
});

describe("ScipPythonIndexer", () => {
  let indexer: ScipPythonIndexer;
  let tempDir: string;

  beforeEach(() => {
    indexer = new ScipPythonIndexer();
    tempDir = mkdtempSync(join(tmpdir(), "scip-py-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("name", () => {
    it("should have a descriptive name", () => {
      expect(indexer.name).toBe("scip-python");
    });
  });

  describe("canIndex", () => {
    it("should return false for an empty directory", () => {
      expect(indexer.canIndex(tempDir)).toBe(false);
    });

    it("should return true when pyproject.toml exists", () => {
      writeFileSync(join(tempDir, "pyproject.toml"), "");
      expect(indexer.canIndex(tempDir)).toBe(true);
    });

    it("should return true when setup.py exists", () => {
      writeFileSync(join(tempDir, "setup.py"), "");
      expect(indexer.canIndex(tempDir)).toBe(true);
    });

    it("should return true when requirements.txt exists", () => {
      writeFileSync(join(tempDir, "requirements.txt"), "");
      expect(indexer.canIndex(tempDir)).toBe(true);
    });

    it("should return false when no Python marker files exist", () => {
      writeFileSync(join(tempDir, "package.json"), "{}");
      expect(indexer.canIndex(tempDir)).toBe(false);
    });
  });
});
