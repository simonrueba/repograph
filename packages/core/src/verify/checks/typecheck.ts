import { execSync } from "child_process";
import { existsSync } from "fs";
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
  /** Repograph query suggestions relevant to this error. */
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
 * Build a list of suggested repograph query strings for a given tsc error.
 *
 * Suggestions follow this strategy:
 *  - Every error gets an `impact` suggestion for the file it lives in.
 *  - Common error codes get one or more `search_symbol` / `find_refs`
 *    suggestions based on identifiers extracted from the message text.
 */
export function suggestQueries(
  code: string,
  errorMessage: string,
  file: string,
): string[] {
  const suggestions: string[] = [];

  // Always suggest impact analysis on the affected file.
  if (file) {
    suggestions.push(`repograph query impact ${file}`);
  }

  const identifier = extractIdentifier(errorMessage);

  switch (code) {
    // TS2345 — Argument of type 'X' is not assignable to parameter of type 'Y'
    // Extract the function/parameter name from the message context.
    case "TS2345": {
      if (identifier) {
        suggestions.push(`repograph query search_symbol ${identifier}`);
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
        suggestions.push(`repograph query search_symbol ${exportName}`);
      }
      break;
    }

    // TS2339 — Property 'X' does not exist on type 'Y'
    case "TS2339": {
      if (identifier) {
        suggestions.push(`repograph query search_symbol ${identifier}`);
      }
      break;
    }

    // TS2304 — Cannot find name 'X'
    case "TS2304": {
      if (identifier) {
        suggestions.push(`repograph query search_symbol ${identifier}`);
      }
      break;
    }

    // TS2322 — Type 'X' is not assignable to type 'Y'
    // Suggest find_refs on the target variable in the erroring file.
    case "TS2322": {
      if (file) {
        suggestions.push(`repograph query find_refs ${file}`);
      }
      if (identifier) {
        suggestions.push(`repograph query search_symbol ${identifier}`);
      }
      break;
    }

    default:
      break;
  }

  return suggestions;
}

/** Find the tsc binary — prefer local node_modules, fall back to bunx. */
function findTscCommand(repoRoot: string): string {
  const localTsc = join(repoRoot, "node_modules", ".bin", "tsc");
  if (existsSync(localTsc)) {
    return localTsc;
  }
  return "bunx tsc";
}

/**
 * Run the TypeScript compiler in noEmit mode to catch type errors.
 * Looks for tsconfig.json in the repo root. Skips if none found.
 *
 * Each issue contains:
 *  - `message`: the full raw tsc error line (backward-compatible)
 *  - `file`, `line`, `col`, `code`: structured fields parsed from the line
 *  - `suggestedQueries`: repograph commands relevant to the error
 *
 * Lines that do not match the standard tsc format fall back to the old
 * behaviour: `message` is set and all other fields are left as defaults.
 */
export function checkTypecheck(repoRoot: string): TypecheckResult {
  const tsconfigPath = join(repoRoot, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    return { passed: true, issues: [] };
  }

  const tsc = findTscCommand(repoRoot);

  try {
    execSync(`${tsc} --noEmit -p ${tsconfigPath}`, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { passed: true, issues: [] };
  } catch (err: unknown) {
    const anyErr = err as { stdout?: Buffer; stderr?: Buffer };
    const output =
      (anyErr.stdout?.toString() ?? "") + (anyErr.stderr?.toString() ?? "");

    const errorLines = output
      .split("\n")
      .filter((l: string) => l.includes("error TS"))
      .slice(0, 20); // cap at 20 errors

    const issues: TypecheckIssue[] = errorLines.map((raw: string) => {
      const parsed = parseTscErrorLine(raw, repoRoot);

      if (!parsed) {
        // Unparseable line — fall back to legacy shape.
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

    return { passed: false, issues };
  }
}
