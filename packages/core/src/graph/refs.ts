import type { StoreQueries } from "../store/queries";
import { readFileSync } from "fs";
import { join } from "path";

// ── Result types ──────────────────────────────────────────────────────

export interface SymbolResult {
  id: string;
  name: string;
  kind?: string;
  filePath?: string;
  range?: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
}

export interface DefResult extends SymbolResult {
  doc?: string;
  snippet?: string;
}

export interface RefResult {
  filePath: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  roles: number;
  snippet?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Unpack (line << 16 | col) into {line, col} */
function unpackRange(packed: number): { line: number; col: number } {
  return { line: packed >> 16, col: packed & 0xffff };
}

function formatRange(
  start: number,
  end: number,
): { startLine: number; startCol: number; endLine: number; endCol: number } {
  const s = unpackRange(start);
  const e = unpackRange(end);
  return { startLine: s.line, startCol: s.col, endLine: e.line, endCol: e.col };
}

/** Read up to 3 lines of code starting at startLine for a snippet. */
function getSnippet(
  repoRoot: string,
  filePath: string,
  startLine: number,
): string | undefined {
  try {
    const content = readFileSync(join(repoRoot, filePath), "utf-8");
    const lines = content.split("\n");
    return lines
      .slice(Math.max(0, startLine), Math.min(lines.length, startLine + 3))
      .join("\n");
  } catch {
    return undefined;
  }
}

// ── GraphQueries ──────────────────────────────────────────────────────

export class GraphQueries {
  constructor(
    private store: StoreQueries,
    private repoRoot: string,
  ) {}

  /** Fuzzy-search symbols by name, returning at most `k` results. */
  searchSymbol(query: string, k = 10): SymbolResult[] {
    const all = this.store.searchSymbols(query);
    const limited = all.slice(0, k);
    return limited.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind ?? undefined,
      filePath: s.file_path ?? undefined,
      range:
        s.range_start != null && s.range_end != null
          ? formatRange(s.range_start, s.range_end)
          : undefined,
    }));
  }

  /** Get the definition for a symbol by ID, including doc and snippet. */
  getDef(symbolId: string): DefResult | null {
    const sym = this.store.getSymbol(symbolId);
    if (!sym) return null;

    const range =
      sym.range_start != null && sym.range_end != null
        ? formatRange(sym.range_start, sym.range_end)
        : undefined;

    return {
      id: sym.id,
      name: sym.name,
      kind: sym.kind ?? undefined,
      filePath: sym.file_path ?? undefined,
      range,
      doc: sym.doc ?? undefined,
      snippet:
        sym.file_path && range
          ? getSnippet(this.repoRoot, sym.file_path, range.startLine)
          : undefined,
    };
  }

  /** Find all references (occurrences) for a symbol. */
  findRefs(
    symbolId: string,
    opts?: { excludeDefinitions?: boolean; scope?: string },
  ): RefResult[] {
    let occs = this.store.getOccurrencesBySymbol(symbolId);

    if (opts?.excludeDefinitions) {
      occs = occs.filter((o) => !(o.roles & 1));
    }

    if (opts?.scope) {
      occs = occs.filter((o) => o.file_path.startsWith(opts.scope!));
    }

    return occs.map((o) => {
      const range = formatRange(o.range_start, o.range_end);
      return {
        filePath: o.file_path,
        range,
        roles: o.roles,
        snippet: getSnippet(this.repoRoot, o.file_path, range.startLine),
      };
    });
  }
}
