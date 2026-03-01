import { execFileSync, execFile } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join, relative } from "path";

export interface TypecheckIssue {
  type: "TYPE_ERROR";
  /** Full raw tsc error line (backward-compatible). */
  message: string;
  /** Relative file path extracted from the tsc error, or empty string if unparseable. */
  file: string;
  /** 1-based line number, or 0 if unparseable. */
  line: number;
  /** 1-based column number, or 0 if unparseable. */
  col: number;
  /** TypeScript error code, e.g. "TS2345", or empty string if unparseable. */
  code: string;
  /** Ariadne query suggestions relevant to this error. */
  suggestedQueries?: string[];
}

export interface TypecheckResult {
  passed: boolean;
  issues: TypecheckIssue[];
}

// tsc error line format:
//   /abs/path/to/file.ts(line,col): error TS2345: message text
// or (on Windows / relative paths):
//   path/to/file.ts(line,col): error TS2345: message text
const TSC_ERROR_RE =
  /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

/**
 * Parse a single tsc error line into its structured components.
 * Returns null if the line does not match the expected format.
 */
function parseTscErrorLine(
  line: string,
  repoRoot: string,
): Pick<TypecheckIssue, "file" | "line" | "col" | "code" | "message"> | null {
  const trimmed = line.trim();
  const match = TSC_ERROR_RE.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, rawPath, rawLine, rawCol, code, errorMessage] = match;

  // Strip the repo root prefix to produce a relative path.
  // tsc sometimes outputs absolute paths, sometimes relative — normalise both.
  let file = rawPath.trim();
  if (file.startsWith(repoRoot)) {
    file = relative(repoRoot, file);
  }
  // Normalise any leading "./" that relative() does not add but may appear
  // in tsc output produced with relative paths.
  if (file.startsWith("./")) {
    file = file.slice(2);
  }

  return {
    file,
    line: parseInt(rawLine, 10),
    col: parseInt(rawCol, 10),
    code,
    message: trimmed,
  };
}

/**
 * Extract the first quoted or backtick-quoted identifier from a tsc error
 * message. tsc quotes names with single quotes: `'SomeName'`.
 * Returns null when nothing useful is found.
 */
function extractIdentifier(errorMessage: string): string | null {
  // Match the first occurrence of 'SomeName' or `SomeName`
  const quoted = /['`]([A-Za-z_$][A-Za-z0-9_$.]*)['`]/.exec(errorMessage);
  return quoted ? quoted[1] : null;
}

/**
 * Build a list of suggested ariadne query strings for a given tsc error.
 *
 * Suggestions follow this strategy:
 *  - Every error gets an `impact` suggestion for the file it lives in.
 *  - Common error codes get one or more `search` suggestions based on
 *    identifiers extracted from the message text.
 */
export function suggestQueries(
  code: string,
  errorMessage: string,
  file: string,
): string[] {
  const suggestions: string[] = [];

  // Always suggest impact analysis on the affected file.
  if (file) {
    suggestions.push(`ariadne query impact ${file}`);
  }

  const identifier = extractIdentifier(errorMessage);

  switch (code) {
    // TS2345 — Argument of type 'X' is not assignable to parameter of type 'Y'
    // Extract the function/parameter name from the message context.
    case "TS2345": {
      if (identifier) {
        suggestions.push(`ariadne query search ${identifier}`);
      }
      break;
    }

    // TS2305 — Module '"..."' has no exported member 'X'
    // The missing export is the second quoted name in the message.
    case "TS2305": {
      const allNames = [
        ...errorMessage.matchAll(/['`]([A-Za-z_$][A-Za-z0-9_$.]*)['`]/g),
      ].map((m) => m[1]);
      // The missing export name is typically the last quoted token.
      const exportName = allNames.length > 1 ? allNames[allNames.length - 1] : identifier;
      if (exportName) {
        suggestions.push(`ariadne query search ${exportName}`);
      }
      break;
    }

    // TS2339 — Property 'X' does not exist on type 'Y'
    case "TS2339": {
      if (identifier) {
        suggestions.push(`ariadne query search ${identifier}`);
      }
      break;
    }

    // TS2304 — Cannot find name 'X'
    case "TS2304": {
      if (identifier) {
        suggestions.push(`ariadne query search ${identifier}`);
      }
      break;
    }

    // TS2322 — Type 'X' is not assignable to type 'Y'
    case "TS2322": {
      if (identifier) {
        suggestions.push(`ariadne query search ${identifier}`);
      }
      break;
    }

    default:
      break;
  }

  return suggestions;
}

/** Find the tsc binary — prefer local node_modules, fall back to bunx. */
function findTscCommand(repoRoot: string): { cmd: string; args: string[] } {
  const localTsc = join(repoRoot, "node_modules", ".bin", "tsc");
  if (existsSync(localTsc)) {
    return { cmd: localTsc, args: [] };
  }
  return { cmd: "bunx", args: ["tsc"] };
}

/** Parse tsc output into TypecheckIssue[] */
function parseTscOutput(rawOutput: string, repoRoot: string): TypecheckIssue[] {
  const errorLines = rawOutput
    .split("\n")
    .filter((l: string) => l.includes("error TS"))
    .slice(0, 20); // cap at 20 errors

  return errorLines.map((raw: string) => {
    const parsed = parseTscErrorLine(raw, repoRoot);

    if (!parsed) {
      return {
        type: "TYPE_ERROR" as const,
        message: raw.trim(),
        file: "",
        line: 0,
        col: 0,
        code: "",
      };
    }

    return {
      type: "TYPE_ERROR" as const,
      message: parsed.message,
      file: parsed.file,
      line: parsed.line,
      col: parsed.col,
      code: parsed.code,
      suggestedQueries: suggestQueries(parsed.code, parsed.message, parsed.file),
    };
  });
}

// ── Go vet error format ──────────────────────────────────────────────────
// ./file.go:10:5: error message
const GO_VET_ERROR_RE = /^\.?\/?([\w/.]+\.go):(\d+):(\d+):\s*(.+)$/;

function parseGoVetOutput(rawOutput: string, repoRoot: string): TypecheckIssue[] {
  return rawOutput
    .split("\n")
    .filter((l: string) => /\.go:\d+:\d+:/.test(l))
    .slice(0, 20)
    .map((raw: string) => {
      const match = GO_VET_ERROR_RE.exec(raw.trim());
      if (!match) {
        return { type: "TYPE_ERROR" as const, message: raw.trim(), file: "", line: 0, col: 0, code: "" };
      }
      const [, file, rawLine, rawCol, msg] = match;
      const relFile = file.startsWith(repoRoot) ? relative(repoRoot, file) : file;
      return {
        type: "TYPE_ERROR" as const,
        message: raw.trim(),
        file: relFile,
        line: parseInt(rawLine, 10),
        col: parseInt(rawCol, 10),
        code: "GO_VET",
        suggestedQueries: [`ariadne query impact ${relFile}`],
      };
    });
}

// ── Cargo check error format ─────────────────────────────────────────────
// error[E0308]: mismatched types
//  --> src/main.rs:10:5
const CARGO_ERROR_RE = /^\s*-->\s*([\w/.]+\.rs):(\d+):(\d+)/;
const CARGO_CODE_RE = /^error\[([A-Z]\d+)\]/;

function parseCargoOutput(rawOutput: string, repoRoot: string): TypecheckIssue[] {
  const issues: TypecheckIssue[] = [];
  const lines = rawOutput.split("\n");
  let currentCode = "";

  for (const line of lines) {
    const codeMatch = CARGO_CODE_RE.exec(line);
    if (codeMatch) {
      currentCode = codeMatch[1];
      continue;
    }
    const locMatch = CARGO_ERROR_RE.exec(line);
    if (locMatch) {
      const [, file, rawLine, rawCol] = locMatch;
      const relFile = file.startsWith(repoRoot) ? relative(repoRoot, file) : file;
      issues.push({
        type: "TYPE_ERROR",
        message: `${currentCode}: ${line.trim()}`,
        file: relFile,
        line: parseInt(rawLine, 10),
        col: parseInt(rawCol, 10),
        code: currentCode,
        suggestedQueries: [`ariadne query impact ${relFile}`],
      });
      currentCode = "";
      if (issues.length >= 20) break;
    }
  }
  return issues;
}

// ── Generic error parser for Java/C#/Ruby ────────────────────────────────
// Matches lines like: file.java:10: error: message or file.cs(10,5): error CS1234: message
const GENERIC_ERROR_RE = /^(.+?)[:(](\d+)[,:]?(\d*)\)?:?\s*(?:error\s*)?(.+)$/;

function parseGenericOutput(rawOutput: string, repoRoot: string, filePattern: RegExp): TypecheckIssue[] {
  return rawOutput
    .split("\n")
    .filter((l: string) => filePattern.test(l) && /error/i.test(l))
    .slice(0, 20)
    .map((raw: string) => {
      const match = GENERIC_ERROR_RE.exec(raw.trim());
      if (!match) {
        return { type: "TYPE_ERROR" as const, message: raw.trim(), file: "", line: 0, col: 0, code: "" };
      }
      const [, file, rawLine, rawCol, msg] = match;
      const relFile = file.startsWith(repoRoot) ? relative(repoRoot, file) : file;
      return {
        type: "TYPE_ERROR" as const,
        message: raw.trim(),
        file: relFile,
        line: parseInt(rawLine, 10),
        col: rawCol ? parseInt(rawCol, 10) : 0,
        code: "",
        suggestedQueries: [`ariadne query impact ${relFile}`],
      };
    });
}

/**
 * Run the TypeScript compiler in noEmit mode to catch type errors (sync).
 * Looks for tsconfig.json in the repo root. Skips if none found.
 */
export function checkTypecheck(repoRoot: string): TypecheckResult {
  const allIssues: TypecheckIssue[] = [];
  let anyCheckerRan = false;

  // TypeScript: tsc --noEmit
  const tsconfigPath = join(repoRoot, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    anyCheckerRan = true;
    const { cmd: tscCmd, args: tscArgs } = findTscCommand(repoRoot);
    try {
      execFileSync(tscCmd, [...tscArgs, "--noEmit", "-p", tsconfigPath], {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch (err: unknown) {
      const anyErr = err as { stdout?: Buffer; stderr?: Buffer };
      const output =
        (anyErr.stdout?.toString() ?? "") + (anyErr.stderr?.toString() ?? "");
      allIssues.push(...parseTscOutput(output, repoRoot));
    }
  }

  // Go: go vet ./...
  if (existsSync(join(repoRoot, "go.mod"))) {
    anyCheckerRan = true;
    try {
      execFileSync("go", ["vet", "./..."], {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch (err: unknown) {
      const anyErr = err as { stdout?: Buffer; stderr?: Buffer };
      const output =
        (anyErr.stdout?.toString() ?? "") + (anyErr.stderr?.toString() ?? "");
      allIssues.push(...parseGoVetOutput(output, repoRoot));
    }
  }

  // Rust: cargo check
  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    anyCheckerRan = true;
    try {
      execFileSync("cargo", ["check", "--message-format=short"], {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 180_000,
      });
    } catch (err: unknown) {
      const anyErr = err as { stdout?: Buffer; stderr?: Buffer };
      const output =
        (anyErr.stdout?.toString() ?? "") + (anyErr.stderr?.toString() ?? "");
      allIssues.push(...parseCargoOutput(output, repoRoot));
    }
  }

  // Java: mvn compile (or javac)
  if (existsSync(join(repoRoot, "pom.xml")) || existsSync(join(repoRoot, "build.gradle")) || existsSync(join(repoRoot, "build.gradle.kts"))) {
    anyCheckerRan = true;
    const [javaCmd, ...javaArgs] = existsSync(join(repoRoot, "pom.xml"))
      ? ["mvn", "compile", "-q"]
      : ["gradle", "compileJava", "-q"];
    try {
      execFileSync(javaCmd, javaArgs, {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 180_000,
      });
    } catch (err: unknown) {
      const anyErr = err as { stdout?: Buffer; stderr?: Buffer };
      const output =
        (anyErr.stdout?.toString() ?? "") + (anyErr.stderr?.toString() ?? "");
      allIssues.push(...parseGenericOutput(output, repoRoot, /\.java|\.kt/));
    }
  }

  // C#: dotnet build
  {
    let hasCsharp = false;
    try {
      const entries = readdirSync(repoRoot);
      hasCsharp = entries.some((e) => e.endsWith(".sln") || e.endsWith(".csproj"));
    } catch { /* skip */ }
    if (hasCsharp) {
      anyCheckerRan = true;
      try {
        execFileSync("dotnet", ["build", "--no-restore", "-v", "q"], {
          cwd: repoRoot,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 180_000,
        });
      } catch (err: unknown) {
        const anyErr = err as { stdout?: Buffer; stderr?: Buffer };
        const output =
          (anyErr.stdout?.toString() ?? "") + (anyErr.stderr?.toString() ?? "");
        allIssues.push(...parseGenericOutput(output, repoRoot, /\.cs/));
      }
    }
  }

  // Scala: sbt compile
  if (existsSync(join(repoRoot, "build.sbt"))) {
    anyCheckerRan = true;
    try {
      execFileSync("sbt", ["compile", "-q"], {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 180_000,
      });
    } catch (err: unknown) {
      const anyErr = err as { stdout?: Buffer; stderr?: Buffer };
      const output =
        (anyErr.stdout?.toString() ?? "") + (anyErr.stderr?.toString() ?? "");
      allIssues.push(...parseGenericOutput(output, repoRoot, /\.scala/));
    }
  }

  // Ruby: ruby -c (syntax check) — lightweight, no rubocop dependency
  if (existsSync(join(repoRoot, "Gemfile"))) {
    anyCheckerRan = true;
    try {
      execFileSync("ruby", ["-c", "-e", ""], {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });
    } catch { /* ruby -c on empty string always passes; real check is rubocop */ }
  }

  if (!anyCheckerRan) {
    return { passed: true, issues: [] };
  }

  return { passed: allIssues.length === 0, issues: allIssues };
}

/**
 * Async version of checkTypecheck — uses child_process.exec so it can run
 * in parallel with other checks via Promise.all.
 */
export function checkTypecheckAsync(repoRoot: string): Promise<TypecheckResult> {
  const checkers: Promise<TypecheckIssue[]>[] = [];

  // TypeScript
  const tsconfigPath = join(repoRoot, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    const { cmd: tscCmd2, args: tscArgs2 } = findTscCommand(repoRoot);
    checkers.push(
      new Promise((resolve) => {
        execFile(tscCmd2, [...tscArgs2, "--noEmit", "-p", tsconfigPath], { cwd: repoRoot, timeout: 120_000 }, (error, stdout, stderr) => {
          if (!error) { resolve([]); return; }
          resolve(parseTscOutput((stdout ?? "") + (stderr ?? ""), repoRoot));
        });
      }),
    );
  }

  // Go
  if (existsSync(join(repoRoot, "go.mod"))) {
    checkers.push(
      new Promise((resolve) => {
        execFile("go", ["vet", "./..."], { cwd: repoRoot, timeout: 120_000 }, (error, stdout, stderr) => {
          if (!error) { resolve([]); return; }
          resolve(parseGoVetOutput((stdout ?? "") + (stderr ?? ""), repoRoot));
        });
      }),
    );
  }

  // Rust
  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    checkers.push(
      new Promise((resolve) => {
        execFile("cargo", ["check", "--message-format=short"], { cwd: repoRoot, timeout: 180_000 }, (error, stdout, stderr) => {
          if (!error) { resolve([]); return; }
          resolve(parseCargoOutput((stdout ?? "") + (stderr ?? ""), repoRoot));
        });
      }),
    );
  }

  // Java
  if (existsSync(join(repoRoot, "pom.xml")) || existsSync(join(repoRoot, "build.gradle")) || existsSync(join(repoRoot, "build.gradle.kts"))) {
    const [javaCmd2, ...javaArgs2] = existsSync(join(repoRoot, "pom.xml"))
      ? ["mvn", "compile", "-q"]
      : ["gradle", "compileJava", "-q"];
    checkers.push(
      new Promise((resolve) => {
        execFile(javaCmd2, javaArgs2, { cwd: repoRoot, timeout: 180_000 }, (error, stdout, stderr) => {
          if (!error) { resolve([]); return; }
          resolve(parseGenericOutput((stdout ?? "") + (stderr ?? ""), repoRoot, /\.java|\.kt/));
        });
      }),
    );
  }

  // C#
  {
    let hasCsharp = false;
    try {
      const entries = readdirSync(repoRoot);
      hasCsharp = entries.some((e) => e.endsWith(".sln") || e.endsWith(".csproj"));
    } catch { /* skip */ }
    if (hasCsharp) {
      checkers.push(
        new Promise((resolve) => {
          execFile("dotnet", ["build", "--no-restore", "-v", "q"], { cwd: repoRoot, timeout: 180_000 }, (error, stdout, stderr) => {
            if (!error) { resolve([]); return; }
            resolve(parseGenericOutput((stdout ?? "") + (stderr ?? ""), repoRoot, /\.cs/));
          });
        }),
      );
    }
  }

  // Scala
  if (existsSync(join(repoRoot, "build.sbt"))) {
    checkers.push(
      new Promise((resolve) => {
        execFile("sbt", ["compile", "-q"], { cwd: repoRoot, timeout: 180_000 }, (error, stdout, stderr) => {
          if (!error) { resolve([]); return; }
          resolve(parseGenericOutput((stdout ?? "") + (stderr ?? ""), repoRoot, /\.scala/));
        });
      }),
    );
  }

  if (checkers.length === 0) {
    return Promise.resolve({ passed: true, issues: [] });
  }

  return Promise.all(checkers).then((results) => {
    const allIssues = results.flat();
    return { passed: allIssues.length === 0, issues: allIssues };
  });
}
