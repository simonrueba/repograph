import { readFileSync } from "fs";
import { join } from "path";

/** Unpack (line << 16 | col) into {line, col} */
export function unpackRange(packed: number): { line: number; col: number } {
  return { line: packed >> 16, col: packed & 0xffff };
}

export function formatRange(
  start: number,
  end: number,
): { startLine: number; startCol: number; endLine: number; endCol: number } {
  const s = unpackRange(start);
  const e = unpackRange(end);
  return { startLine: s.line, startCol: s.col, endLine: e.line, endCol: e.col };
}

/** Per-query file content cache to avoid redundant readFileSync calls. */
export type SnippetCache = Map<string, string[]>;

export function createSnippetCache(): SnippetCache {
  return new Map();
}

/** Read up to 3 lines of code starting at startLine for a snippet. */
export function getSnippet(
  repoRoot: string,
  filePath: string,
  startLine: number,
  cache?: SnippetCache,
): string | undefined {
  try {
    let lines: string[] | undefined;
    if (cache) {
      lines = cache.get(filePath);
      if (!lines) {
        lines = readFileSync(join(repoRoot, filePath), "utf-8").split("\n");
        cache.set(filePath, lines);
      }
    } else {
      lines = readFileSync(join(repoRoot, filePath), "utf-8").split("\n");
    }
    return lines
      .slice(Math.max(0, startLine), Math.min(lines.length, startLine + 3))
      .join("\n");
  } catch {
    return undefined;
  }
}
