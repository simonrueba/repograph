import type { StoreQueries } from "../store/queries";
import { unpackRange, formatRange, getSnippet } from "./utils";

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

export interface CallGraphResult {
  root: string;
  callers: { id: string; name: string; filePath?: string }[];
  callees: { id: string; name: string; filePath?: string }[];
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

  /** Get the call graph for a symbol: who calls it and what it calls. */
  getCallGraph(symbolId: string, depth = 1): CallGraphResult {
    const callers: CallGraphResult["callers"] = [];
    const callees: CallGraphResult["callees"] = [];
    const seenCallers = new Set<string>();
    const seenCallees = new Set<string>();

    const collectCallers = (id: string, remaining: number) => {
      if (remaining <= 0) return;
      for (const edge of this.store.getCallers(id)) {
        if (seenCallers.has(edge.source)) continue;
        seenCallers.add(edge.source);
        const sym = this.store.getSymbol(edge.source);
        if (sym) {
          callers.push({ id: sym.id, name: sym.name, filePath: sym.file_path ?? undefined });
          collectCallers(sym.id, remaining - 1);
        }
      }
    };

    const collectCallees = (id: string, remaining: number) => {
      if (remaining <= 0) return;
      for (const edge of this.store.getCallees(id)) {
        if (seenCallees.has(edge.target)) continue;
        seenCallees.add(edge.target);
        const sym = this.store.getSymbol(edge.target);
        if (sym) {
          callees.push({ id: sym.id, name: sym.name, filePath: sym.file_path ?? undefined });
          collectCallees(sym.id, remaining - 1);
        }
      }
    };

    collectCallers(symbolId, depth);
    collectCallees(symbolId, depth);

    return { root: symbolId, callers, callees };
  }
}
