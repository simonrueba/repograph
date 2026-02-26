import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { suggestQueries, checkTypecheck } from "../checks/typecheck";

// ── suggestQueries ────────────────────────────────────────────────────

describe("suggestQueries", () => {
  describe("TS2345 — Argument of type 'X' is not assignable to parameter of type 'Y'", () => {
    it("should suggest impact and search_symbol for the first quoted identifier", () => {
      const suggestions = suggestQueries(
        "TS2345",
        "Argument of type 'string' is not assignable to parameter of type 'number'.",
        "src/utils.ts",
      );
      expect(suggestions).toContain("repograph query impact src/utils.ts");
      expect(suggestions).toContain("repograph query search_symbol string");
    });

    it("should suggest only impact when message has no quoted identifier", () => {
      const suggestions = suggestQueries(
        "TS2345",
        "Argument of type is not assignable to parameter type.",
        "src/utils.ts",
      );
      expect(suggestions).toContain("repograph query impact src/utils.ts");
      expect(suggestions).toHaveLength(1);
    });
  });

  describe("TS2305 — Module '...' has no exported member 'X'", () => {
    it("should suggest impact and search_symbol for the last quoted identifier", () => {
      // The last quoted identifier is the missing export name
      const suggestions = suggestQueries(
        "TS2305",
        "Module 'src/math' has no exported member 'subtract'.",
        "src/index.ts",
      );
      expect(suggestions).toContain("repograph query impact src/index.ts");
      expect(suggestions).toContain("repograph query search_symbol subtract");
    });

    it("should fall back to first identifier when only one quoted token exists", () => {
      const suggestions = suggestQueries(
        "TS2305",
        "Module has no exported member 'missingExport'.",
        "src/index.ts",
      );
      expect(suggestions).toContain("repograph query search_symbol missingExport");
    });
  });

  describe("TS2339 — Property 'X' does not exist on type 'Y'", () => {
    it("should suggest impact and search_symbol for the property name", () => {
      const suggestions = suggestQueries(
        "TS2339",
        "Property 'foo' does not exist on type 'Bar'.",
        "src/component.ts",
      );
      expect(suggestions).toContain("repograph query impact src/component.ts");
      expect(suggestions).toContain("repograph query search_symbol foo");
    });

    it("should suggest only impact when no identifier is found", () => {
      const suggestions = suggestQueries(
        "TS2339",
        "Property does not exist on type.",
        "src/component.ts",
      );
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toBe("repograph query impact src/component.ts");
    });
  });

  describe("TS2304 — Cannot find name 'X'", () => {
    it("should suggest impact and search_symbol for the missing name", () => {
      const suggestions = suggestQueries(
        "TS2304",
        "Cannot find name 'MyClass'.",
        "src/app.ts",
      );
      expect(suggestions).toContain("repograph query impact src/app.ts");
      expect(suggestions).toContain("repograph query search_symbol MyClass");
    });

    it("should suggest only impact when no identifier is quoted", () => {
      const suggestions = suggestQueries(
        "TS2304",
        "Cannot find name.",
        "src/app.ts",
      );
      expect(suggestions).toHaveLength(1);
    });
  });

  describe("TS2322 — Type 'X' is not assignable to type 'Y'", () => {
    it("should suggest impact, find_refs, and search_symbol", () => {
      const suggestions = suggestQueries(
        "TS2322",
        "Type 'string' is not assignable to type 'number'.",
        "src/parser.ts",
      );
      expect(suggestions).toContain("repograph query impact src/parser.ts");
      expect(suggestions).toContain("repograph query find_refs src/parser.ts");
      expect(suggestions).toContain("repograph query search_symbol string");
    });

    it("should include exactly three suggestions when identifier is present", () => {
      const suggestions = suggestQueries(
        "TS2322",
        "Type 'boolean' is not assignable to type 'string'.",
        "src/validate.ts",
      );
      expect(suggestions).toHaveLength(3);
    });

    it("should include impact and find_refs even when no identifier is present", () => {
      const suggestions = suggestQueries(
        "TS2322",
        "Type is not assignable to type.",
        "src/validate.ts",
      );
      expect(suggestions).toContain("repograph query impact src/validate.ts");
      expect(suggestions).toContain("repograph query find_refs src/validate.ts");
    });
  });

  describe("unknown error code", () => {
    it("should suggest only impact for an unrecognised error code", () => {
      const suggestions = suggestQueries(
        "TS9999",
        "Some unknown TypeScript error with 'identifier'.",
        "src/foo.ts",
      );
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toBe("repograph query impact src/foo.ts");
    });

    it("should return an empty array when file is empty string", () => {
      const suggestions = suggestQueries("TS9999", "Some error.", "");
      expect(suggestions).toHaveLength(0);
    });
  });

  describe("empty file argument", () => {
    it("should skip the impact suggestion when file is empty", () => {
      const suggestions = suggestQueries(
        "TS2345",
        "Argument of type 'Foo' is not assignable to parameter of type 'Bar'.",
        "",
      );
      // No impact suggestion since file is falsy; search_symbol still appears
      expect(suggestions).not.toContain("repograph query impact ");
      expect(suggestions).toContain("repograph query search_symbol Foo");
    });

    it("should not emit find_refs when file is empty for TS2322", () => {
      const suggestions = suggestQueries(
        "TS2322",
        "Type 'X' is not assignable to type 'Y'.",
        "",
      );
      const findRefs = suggestions.filter((s) => s.startsWith("repograph query find_refs"));
      // find_refs is guarded by `if (file)` in the implementation
      expect(findRefs).toHaveLength(0);
    });
  });

  describe("identifier extraction edge cases", () => {
    it("should match backtick-quoted identifiers as well as single-quoted ones", () => {
      const suggestions = suggestQueries(
        "TS2304",
        "Cannot find name `MyInterface`.",
        "src/types.ts",
      );
      expect(suggestions).toContain("repograph query search_symbol MyInterface");
    });

    it("should handle dotted identifier names such as 'Foo.bar'", () => {
      const suggestions = suggestQueries(
        "TS2339",
        "Property 'Foo.bar' does not exist on type 'Baz'.",
        "src/service.ts",
      );
      expect(suggestions).toContain("repograph query search_symbol Foo.bar");
    });
  });
});

// ── checkTypecheck ────────────────────────────────────────────────────

describe("checkTypecheck", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "repograph-typecheck-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return passed:true when no tsconfig.json exists in repoRoot", () => {
    // tempDir contains no tsconfig.json — function should short-circuit
    const result = checkTypecheck(tempDir);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
