import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  suggestQueries,
  checkTypecheck,
  checkTypecheckAsync,
  parseTscErrorLine,
  extractIdentifier,
  parseTscOutput,
  parseGoVetOutput,
  parseCargoOutput,
  parseGenericOutput,
} from "../checks/typecheck";

// ── parseTscErrorLine ─────────────────────────────────────────────────

describe("parseTscErrorLine", () => {
  it("should parse a standard tsc error line", () => {
    const line = "src/utils.ts(10,5): error TS2345: Argument of type 'string' is not assignable.";
    const result = parseTscErrorLine(line, "/repo");
    expect(result).not.toBeNull();
    expect(result!.file).toBe("src/utils.ts");
    expect(result!.line).toBe(10);
    expect(result!.col).toBe(5);
    expect(result!.code).toBe("TS2345");
  });

  it("should strip absolute repo root prefix from file path", () => {
    const line = "/repo/src/main.ts(1,1): error TS2304: Cannot find name 'x'.";
    const result = parseTscErrorLine(line, "/repo");
    expect(result).not.toBeNull();
    expect(result!.file).toBe("src/main.ts");
  });

  it("should strip leading ./ from relative paths", () => {
    const line = "./src/main.ts(5,3): error TS2322: Type 'string' is not assignable.";
    const result = parseTscErrorLine(line, "/repo");
    expect(result).not.toBeNull();
    expect(result!.file).toBe("src/main.ts");
  });

  it("should return null for non-matching lines", () => {
    expect(parseTscErrorLine("some random line", "/repo")).toBeNull();
    expect(parseTscErrorLine("", "/repo")).toBeNull();
    expect(parseTscErrorLine("warning: something", "/repo")).toBeNull();
  });

  it("should handle whitespace-padded lines", () => {
    const line = "   src/a.ts(2,1): error TS1234: Some error.   ";
    const result = parseTscErrorLine(line, "/repo");
    expect(result).not.toBeNull();
    expect(result!.file).toBe("src/a.ts");
    expect(result!.code).toBe("TS1234");
  });
});

// ── extractIdentifier ────────────────────────────────────────────────

describe("extractIdentifier", () => {
  it("should extract single-quoted identifier", () => {
    expect(extractIdentifier("Type 'MyType' is not assignable")).toBe("MyType");
  });

  it("should extract backtick-quoted identifier", () => {
    expect(extractIdentifier("Cannot find name `Foo`")).toBe("Foo");
  });

  it("should return the first quoted identifier when multiple exist", () => {
    expect(extractIdentifier("'First' is not assignable to 'Second'")).toBe("First");
  });

  it("should return null when no quoted identifier exists", () => {
    expect(extractIdentifier("Some error without quotes")).toBeNull();
  });

  it("should handle dotted names like Foo.bar", () => {
    expect(extractIdentifier("Property 'Foo.bar' does not exist")).toBe("Foo.bar");
  });

  it("should handle $ in identifier names", () => {
    expect(extractIdentifier("Cannot find '$store'")).toBe("$store");
  });

  it("should handle _ prefixed identifiers", () => {
    expect(extractIdentifier("Unused '_private'")).toBe("_private");
  });
});

// ── parseTscOutput ───────────────────────────────────────────────────

describe("parseTscOutput", () => {
  it("should parse multiple tsc error lines", () => {
    const output = [
      "src/a.ts(1,5): error TS2304: Cannot find name 'x'.",
      "src/b.ts(3,10): error TS2345: Argument type mismatch.",
    ].join("\n");
    const issues = parseTscOutput(output, "/repo");
    expect(issues).toHaveLength(2);
    expect(issues[0].file).toBe("src/a.ts");
    expect(issues[1].file).toBe("src/b.ts");
  });

  it("should filter out non-error lines", () => {
    const output = [
      "Found 2 errors.",
      "src/a.ts(1,5): error TS2304: Cannot find name 'x'.",
      "",
      "some other output",
    ].join("\n");
    const issues = parseTscOutput(output, "/repo");
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("TS2304");
  });

  it("should cap at 20 errors", () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      `src/f${i}.ts(1,1): error TS2304: Cannot find name 'x${i}'.`
    ).join("\n");
    const issues = parseTscOutput(lines, "/repo");
    expect(issues).toHaveLength(20);
  });

  it("should include suggestedQueries on parsed issues", () => {
    const output = "src/a.ts(1,5): error TS2304: Cannot find name 'MyClass'.";
    const issues = parseTscOutput(output, "/repo");
    expect(issues[0].suggestedQueries).toBeDefined();
    expect(issues[0].suggestedQueries!).toContain("ariadne query impact src/a.ts");
    expect(issues[0].suggestedQueries!).toContain("ariadne query search MyClass");
  });

  it("should handle unparseable error lines with fallback", () => {
    const output = "weird error TS9999 without standard format";
    const issues = parseTscOutput(output, "/repo");
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe("");
    expect(issues[0].code).toBe("");
    expect(issues[0].line).toBe(0);
  });

  it("should return empty for output with no errors", () => {
    const output = "Compilation successful.\nNo errors found.";
    expect(parseTscOutput(output, "/repo")).toHaveLength(0);
  });
});

// ── parseGoVetOutput ─────────────────────────────────────────────────

describe("parseGoVetOutput", () => {
  it("should parse go vet error lines", () => {
    const output = "./cmd/main.go:10:5: unreachable code";
    const issues = parseGoVetOutput(output, "/repo");
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe("cmd/main.go");
    expect(issues[0].line).toBe(10);
    expect(issues[0].col).toBe(5);
    expect(issues[0].code).toBe("GO_VET");
  });

  it("should parse multiple go vet errors", () => {
    const output = [
      "./pkg/server.go:20:3: unused variable",
      "./pkg/handler.go:15:7: unreachable code",
    ].join("\n");
    const issues = parseGoVetOutput(output, "/repo");
    expect(issues).toHaveLength(2);
  });

  it("should include suggestedQueries with impact command", () => {
    const output = "./main.go:1:1: some error";
    const issues = parseGoVetOutput(output, "/repo");
    expect(issues[0].suggestedQueries).toContain("ariadne query impact main.go");
  });

  it("should handle lines without .go pattern", () => {
    const output = "vet: no Go files";
    const issues = parseGoVetOutput(output, "/repo");
    expect(issues).toHaveLength(0);
  });

  it("should cap at 20 errors", () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      `./f${i}.go:${i + 1}:1: error`
    ).join("\n");
    const issues = parseGoVetOutput(lines, "/repo");
    expect(issues).toHaveLength(20);
  });

  it("should handle non-matching go error lines gracefully", () => {
    // Line contains .go:N:N pattern but doesn't match full regex
    const output = "some prefix ./weird:format.go:1:1: err";
    const issues = parseGoVetOutput(output, "/repo");
    // The filter passes it but regex may or may not match
    expect(issues.length).toBeLessThanOrEqual(1);
    if (issues.length === 1) {
      expect(issues[0].type).toBe("TYPE_ERROR");
    }
  });
});

// ── parseCargoOutput ─────────────────────────────────────────────────

describe("parseCargoOutput", () => {
  it("should parse cargo check error output", () => {
    const output = [
      "error[E0308]: mismatched types",
      " --> src/main.rs:10:5",
    ].join("\n");
    const issues = parseCargoOutput(output, "/repo");
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe("src/main.rs");
    expect(issues[0].line).toBe(10);
    expect(issues[0].col).toBe(5);
    expect(issues[0].code).toBe("E0308");
  });

  it("should parse multiple cargo errors", () => {
    const output = [
      "error[E0308]: mismatched types",
      " --> src/lib.rs:5:3",
      "error[E0425]: cannot find value `x`",
      " --> src/main.rs:20:10",
    ].join("\n");
    const issues = parseCargoOutput(output, "/repo");
    expect(issues).toHaveLength(2);
    expect(issues[0].code).toBe("E0308");
    expect(issues[1].code).toBe("E0425");
  });

  it("should include suggestedQueries", () => {
    const output = [
      "error[E0308]: mismatched types",
      " --> src/lib.rs:5:3",
    ].join("\n");
    const issues = parseCargoOutput(output, "/repo");
    expect(issues[0].suggestedQueries).toContain("ariadne query impact src/lib.rs");
  });

  it("should cap at 20 errors", () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push(`error[E0${String(i).padStart(3, "0")}]: error ${i}`);
      lines.push(` --> src/f${i}.rs:${i + 1}:1`);
    }
    const issues = parseCargoOutput(lines.join("\n"), "/repo");
    expect(issues).toHaveLength(20);
  });

  it("should return empty for clean cargo output", () => {
    const output = "   Compiling myproject v0.1.0\n    Finished dev [unoptimized] target(s)";
    expect(parseCargoOutput(output, "/repo")).toHaveLength(0);
  });
});

// ── parseGenericOutput ───────────────────────────────────────────────

describe("parseGenericOutput", () => {
  it("should parse Java compiler errors", () => {
    const output = "src/Main.java:10: error: cannot find symbol";
    const issues = parseGenericOutput(output, "/repo", /\.java/);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe("src/Main.java");
    expect(issues[0].line).toBe(10);
  });

  it("should parse C# compiler errors", () => {
    const output = "src/Program.cs(15,8): error CS1002: ; expected";
    const issues = parseGenericOutput(output, "/repo", /\.cs/);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe("src/Program.cs");
    expect(issues[0].line).toBe(15);
    expect(issues[0].col).toBe(8);
  });

  it("should filter by file pattern", () => {
    const output = [
      "src/Main.java:10: error: cannot find symbol",
      "src/utils.py:5: error: syntax error",
    ].join("\n");
    const issues = parseGenericOutput(output, "/repo", /\.java/);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toContain("Main.java");
  });

  it("should include suggestedQueries", () => {
    const output = "src/App.java:1: error: class not found";
    const issues = parseGenericOutput(output, "/repo", /\.java/);
    expect(issues[0].suggestedQueries).toContain("ariadne query impact src/App.java");
  });

  it("should cap at 20 errors", () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      `src/F${i}.java:${i + 1}: error: something wrong`
    ).join("\n");
    const issues = parseGenericOutput(lines, "/repo", /\.java/);
    expect(issues).toHaveLength(20);
  });

  it("should return empty when no lines match both file pattern and error", () => {
    const output = "BUILD SUCCESSFUL in 5s\n3 actionable tasks: 3 executed";
    expect(parseGenericOutput(output, "/repo", /\.java/)).toHaveLength(0);
  });

  it("should handle lines without column numbers", () => {
    const output = "src/Main.java:10: error: missing return statement";
    const issues = parseGenericOutput(output, "/repo", /\.java/);
    expect(issues).toHaveLength(1);
    // col should be 0 when not present
    expect(issues[0].col).toBe(0);
  });

  it("should handle Scala error lines", () => {
    const output = "src/App.scala:5: error: not found: value x";
    const issues = parseGenericOutput(output, "/repo", /\.scala/);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toContain("App.scala");
  });
});

// ── suggestQueries ────────────────────────────────────────────────────

describe("suggestQueries", () => {
  describe("TS2345 — Argument of type 'X' is not assignable to parameter of type 'Y'", () => {
    it("should suggest impact and search for the first quoted identifier", () => {
      const suggestions = suggestQueries(
        "TS2345",
        "Argument of type 'string' is not assignable to parameter of type 'number'.",
        "src/utils.ts",
      );
      expect(suggestions).toContain("ariadne query impact src/utils.ts");
      expect(suggestions).toContain("ariadne query search string");
    });

    it("should suggest only impact when message has no quoted identifier", () => {
      const suggestions = suggestQueries(
        "TS2345",
        "Argument of type is not assignable to parameter type.",
        "src/utils.ts",
      );
      expect(suggestions).toContain("ariadne query impact src/utils.ts");
      expect(suggestions).toHaveLength(1);
    });
  });

  describe("TS2305 — Module '...' has no exported member 'X'", () => {
    it("should suggest impact and search for the last quoted identifier", () => {
      // The last quoted identifier is the missing export name
      const suggestions = suggestQueries(
        "TS2305",
        "Module 'src/math' has no exported member 'subtract'.",
        "src/index.ts",
      );
      expect(suggestions).toContain("ariadne query impact src/index.ts");
      expect(suggestions).toContain("ariadne query search subtract");
    });

    it("should fall back to first identifier when only one quoted token exists", () => {
      const suggestions = suggestQueries(
        "TS2305",
        "Module has no exported member 'missingExport'.",
        "src/index.ts",
      );
      expect(suggestions).toContain("ariadne query search missingExport");
    });
  });

  describe("TS2339 — Property 'X' does not exist on type 'Y'", () => {
    it("should suggest impact and search for the property name", () => {
      const suggestions = suggestQueries(
        "TS2339",
        "Property 'foo' does not exist on type 'Bar'.",
        "src/component.ts",
      );
      expect(suggestions).toContain("ariadne query impact src/component.ts");
      expect(suggestions).toContain("ariadne query search foo");
    });

    it("should suggest only impact when no identifier is found", () => {
      const suggestions = suggestQueries(
        "TS2339",
        "Property does not exist on type.",
        "src/component.ts",
      );
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toBe("ariadne query impact src/component.ts");
    });
  });

  describe("TS2304 — Cannot find name 'X'", () => {
    it("should suggest impact and search for the missing name", () => {
      const suggestions = suggestQueries(
        "TS2304",
        "Cannot find name 'MyClass'.",
        "src/app.ts",
      );
      expect(suggestions).toContain("ariadne query impact src/app.ts");
      expect(suggestions).toContain("ariadne query search MyClass");
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
    it("should suggest impact and search for the identifier", () => {
      const suggestions = suggestQueries(
        "TS2322",
        "Type 'string' is not assignable to type 'number'.",
        "src/parser.ts",
      );
      expect(suggestions).toContain("ariadne query impact src/parser.ts");
      expect(suggestions).toContain("ariadne query search string");
    });

    it("should include exactly two suggestions when identifier is present", () => {
      const suggestions = suggestQueries(
        "TS2322",
        "Type 'boolean' is not assignable to type 'string'.",
        "src/validate.ts",
      );
      expect(suggestions).toHaveLength(2);
    });

    it("should include only impact when no identifier is present", () => {
      const suggestions = suggestQueries(
        "TS2322",
        "Type is not assignable to type.",
        "src/validate.ts",
      );
      expect(suggestions).toContain("ariadne query impact src/validate.ts");
      expect(suggestions).toHaveLength(1);
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
      expect(suggestions[0]).toBe("ariadne query impact src/foo.ts");
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
      // No impact suggestion since file is falsy; search still appears
      expect(suggestions).not.toContain("ariadne query impact ");
      expect(suggestions).toContain("ariadne query search Foo");
    });

    it("should emit only search when file is empty for TS2322", () => {
      const suggestions = suggestQueries(
        "TS2322",
        "Type 'X' is not assignable to type 'Y'.",
        "",
      );
      // No impact suggestion since file is falsy; only search for identifier
      expect(suggestions).toHaveLength(1);
      expect(suggestions).toContain("ariadne query search X");
    });
  });

  describe("identifier extraction edge cases", () => {
    it("should match backtick-quoted identifiers as well as single-quoted ones", () => {
      const suggestions = suggestQueries(
        "TS2304",
        "Cannot find name `MyInterface`.",
        "src/types.ts",
      );
      expect(suggestions).toContain("ariadne query search MyInterface");
    });

    it("should handle dotted identifier names such as 'Foo.bar'", () => {
      const suggestions = suggestQueries(
        "TS2339",
        "Property 'Foo.bar' does not exist on type 'Baz'.",
        "src/service.ts",
      );
      expect(suggestions).toContain("ariadne query search Foo.bar");
    });
  });
});

// ── checkTypecheck ────────────────────────────────────────────────────

describe("checkTypecheck", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ariadne-typecheck-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFile(relativePath: string, content: string): void {
    const fullPath = join(tempDir, relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  it("should return passed:true when no tsconfig.json exists in repoRoot", () => {
    // tempDir contains no tsconfig.json — function should short-circuit
    const result = checkTypecheck(tempDir);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("should return passed:true when tsconfig exists and code has no errors", { timeout: 30_000 }, () => {
    writeFile("tsconfig.json", JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ["src"],
    }));
    writeFile("src/ok.ts", "export const x: number = 42;\n");

    const result = checkTypecheck(tempDir);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("should detect type errors and return structured issues", { timeout: 30_000 }, () => {
    writeFile("tsconfig.json", JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ["src"],
    }));
    writeFile("src/bad.ts", "const x: number = 'hello';\n");

    const result = checkTypecheck(tempDir);
    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);

    const issue = result.issues[0];
    expect(issue.type).toBe("TYPE_ERROR");
    expect(issue.file).toContain("bad.ts");
    expect(issue.line).toBeGreaterThan(0);
    expect(issue.col).toBeGreaterThan(0);
    expect(issue.code).toMatch(/^TS\d+$/);
  });

  it("should include suggestedQueries for type errors", { timeout: 30_000 }, () => {
    writeFile("tsconfig.json", JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ["src"],
    }));
    writeFile("src/bad.ts", "const x: number = 'oops';\n");

    const result = checkTypecheck(tempDir);
    expect(result.passed).toBe(false);
    const issue = result.issues[0];
    expect(issue.suggestedQueries).toBeDefined();
    expect(issue.suggestedQueries!.length).toBeGreaterThanOrEqual(1);
    // Should always suggest impact on the error file
    expect(issue.suggestedQueries!.some(q => q.startsWith("ariadne query impact"))).toBe(true);
  });

  it("should cap errors at 20", { timeout: 30_000 }, () => {
    writeFile("tsconfig.json", JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ["src"],
    }));
    // Generate 30 type errors
    const lines = Array.from({ length: 30 }, (_, i) => `const x${i}: number = 'bad${i}';`).join("\n");
    writeFile("src/many-errors.ts", lines + "\n");

    const result = checkTypecheck(tempDir);
    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeLessThanOrEqual(20);
  });

  it("should produce relative file paths in issues", { timeout: 30_000 }, () => {
    writeFile("tsconfig.json", JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ["src"],
    }));
    writeFile("src/nested/deep.ts", "const x: number = true;\n");

    const result = checkTypecheck(tempDir);
    expect(result.passed).toBe(false);
    const issue = result.issues[0];
    // Path should be relative, not absolute
    expect(issue.file).not.toStartWith("/");
    expect(issue.file).toContain("deep.ts");
  });
});

// ── checkTypecheckAsync ──────────────────────────────────────────────

describe("checkTypecheckAsync", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ariadne-typecheck-async-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFile(relativePath: string, content: string): void {
    const fullPath = join(tempDir, relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  it("should return passed:true when no checker configs exist", async () => {
    const result = await checkTypecheckAsync(tempDir);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("should return passed:true when TypeScript code is valid", { timeout: 30_000 }, async () => {
    writeFile("tsconfig.json", JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ["src"],
    }));
    writeFile("src/ok.ts", "export const x: number = 42;\n");

    const result = await checkTypecheckAsync(tempDir);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("should detect type errors asynchronously", { timeout: 30_000 }, async () => {
    writeFile("tsconfig.json", JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ["src"],
    }));
    writeFile("src/bad.ts", "const x: number = 'async-oops';\n");

    const result = await checkTypecheckAsync(tempDir);
    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    expect(result.issues[0].type).toBe("TYPE_ERROR");
    expect(result.issues[0].file).toContain("bad.ts");
    expect(result.issues[0].code).toMatch(/^TS\d+$/);
  });

  it("should produce identical results to sync version", { timeout: 30_000 }, async () => {
    writeFile("tsconfig.json", JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ["src"],
    }));
    writeFile("src/bad.ts", "const y: string = 123;\n");

    const syncResult = checkTypecheck(tempDir);
    const asyncResult = await checkTypecheckAsync(tempDir);

    expect(asyncResult.passed).toBe(syncResult.passed);
    expect(asyncResult.issues.length).toBe(syncResult.issues.length);
    if (asyncResult.issues.length > 0) {
      expect(asyncResult.issues[0].code).toBe(syncResult.issues[0].code);
      expect(asyncResult.issues[0].file).toBe(syncResult.issues[0].file);
    }
  });
});
