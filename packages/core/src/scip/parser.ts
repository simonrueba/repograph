import * as protobuf from "protobufjs";
import { join } from "path";
import { decodeScipRange, packRange, SymbolRole } from "./types";
import type {
  StoreQueries,
  SymbolRecord,
  EdgeRecord,
  OccurrenceRecord,
} from "../store/queries";

/**
 * Extract a human-readable name from a SCIP symbol string.
 *
 * SCIP symbol format:
 *   "scip-typescript npm ariadne-core 0.1.0 src/store/`db.ts`/createDatabase()."
 *   "scip-typescript npm ariadne-core 0.1.0 src/store/`queries.ts`/StoreQueries#"
 *   "scip-typescript npm ariadne-core 0.1.0 src/store/`queries.ts`/StoreQueries#upsertFile()."
 *
 * Descriptors use suffixes: . (term), # (type), () (method params)
 * Backtick-quoted segments are file/namespace names, NOT symbol names.
 * The actual symbol name is the last unquoted descriptor.
 */
function extractSymbolName(scipSymbol: string): string {
  // Match all descriptors: sequences of word chars followed by a suffix (., #, (), [])
  // This finds things like "createDatabase().", "StoreQueries#", "upsertFile()."
  const descriptorRe = /(?<=\/|#)([A-Za-z_$][A-Za-z0-9_$]*)(?:\(\))?[.#]/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = descriptorRe.exec(scipSymbol)) !== null) {
    matches.push(m[1]);
  }
  if (matches.length > 0) {
    return matches[matches.length - 1];
  }

  // Try backtick-quoted names as fallback (e.g. `<constructor>`)
  const backtickMatches = scipSymbol.match(/`([^`]+)`/g);
  if (backtickMatches) {
    const last = backtickMatches[backtickMatches.length - 1].replace(/`/g, "");
    // Skip file-like names (contain dots suggesting extensions)
    if (!last.includes(".")) return last;
  }

  // Last resort: split and pick last meaningful part
  const parts = scipSymbol.split(/[\s/]/);
  const last = parts
    .filter(
      (p) =>
        p.length > 0 &&
        !p.startsWith("`") &&
        p !== "#" &&
        p !== "()" &&
        !p.match(/^\d+\.\d+\.\d+$/),
    )
    .pop();
  return last?.replace(/[()#.]/g, "") || scipSymbol;
}

/**
 * Map SCIP SymbolInformation.Kind enum values to human-readable strings.
 *
 * Values from scip.proto `SymbolInformation.Kind` enum.
 */
function scipKindToString(kind?: number): string | undefined {
  if (!kind) return undefined; // 0 = UnspecifiedKind
  const kinds: Record<number, string> = {
    1: "array",
    7: "class",
    8: "constant",
    9: "constructor",
    11: "enum",
    12: "enum_member",
    15: "field",
    17: "function",
    18: "getter",
    21: "interface",
    25: "macro",
    26: "method",
    29: "module",
    30: "namespace",
    33: "object",
    35: "package",
    37: "parameter",
    41: "property",
    45: "setter",
    49: "struct",
    53: "trait",
    54: "type",
    55: "type_alias",
    58: "type_parameter",
    61: "variable",
    66: "abstract_method",
    80: "static_method",
    81: "static_property",
    82: "static_variable",
  };
  return kinds[kind];
}

/**
 * Infer symbol kind from SCIP symbol descriptor suffixes.
 *
 * Many indexers (including scip-typescript) emit Kind=0 (UnspecifiedKind)
 * for all symbols.  The symbol string's descriptor chain encodes structural
 * information we can use as a fallback:
 *
 *   - `#`           → type (class / interface)
 *   - `().`         → method (if preceded by `#`) or function
 *   - `(paramName)` → parameter
 *   - `[name]`      → type_parameter
 *   - `.`           → variable (catch-all term descriptor)
 */
function inferKindFromSymbol(symbol: string): string | undefined {
  // Parameter: ends with `(name)` — a named parameter descriptor
  if (/\([\w$]+\)$/.test(symbol)) return "parameter";
  // Type parameter: ends with `[name]`
  if (/\[[\w$]+\]$/.test(symbol)) return "type_parameter";
  // Type: ends with `#` — a type descriptor (class, interface, etc.)
  if (symbol.endsWith("#")) return "class";
  // Method: `().` preceded by `#` somewhere — method on a type
  if (/#[^/]*\(\)\.$/.test(symbol)) return "method";
  // Function: ends with `().` without a preceding `#` — top-level function
  if (/\(\)\.$/.test(symbol)) return "function";
  // Variable: ends with `.` — a generic term descriptor
  if (symbol.endsWith(".")) return "variable";
  return undefined;
}

export class ScipParser {
  private root: protobuf.Root | null = null;

  /**
   * Load and parse the SCIP protobuf schema.
   * Must be called before `parse()` (called automatically if needed).
   */
  async loadProto(): Promise<void> {
    const protoPath = join(import.meta.dir, "scip.proto");
    this.root = await protobuf.load(protoPath);
  }

  /**
   * Parse a binary SCIP index file (.scip) and return the decoded Index object.
   */
  async parse(scipFilePath: string): Promise<unknown> {
    if (!this.root) await this.loadProto();
    const IndexType = this.root!.lookupType("scip.Index");
    const buffer = await Bun.file(scipFilePath).arrayBuffer();
    const message = IndexType.decode(new Uint8Array(buffer));
    return IndexType.toObject(message, {
      longs: Number,
      enums: Number,
      defaults: true,
      arrays: true,
    });
  }

  /**
   * Ingest a decoded SCIP Index object into the store.
   *
   * This processes all documents, symbols, and occurrences from the index,
   * creating files, symbols, occurrences, and edges in the database.
   *
   * @param options.fileHashes - Map of repo-relative path → content hash.
   *   When provided, documents whose hash matches the stored hash are skipped
   *   (saves re-processing unchanged files during incremental runs).
   * @param options.bulk - When true, uses `bulkTransaction()` which drops indexes
   *   and sets `synchronous = OFF` for the duration. Use for full reindexes.
   */
  ingest(
    index: unknown,
    store: StoreQueries,
    _repoRoot: string,
    projectRoot?: string,
    options?: { fileHashes?: Map<string, string>; bulk?: boolean },
  ): {
    filesIngested: number;
    filesSkipped: number;
    symbolsIngested: number;
    occurrencesIngested: number;
  } {
    const idx = index as { documents?: Array<{
      relativePath: string;
      language?: string;
      symbols?: Array<{ symbol: string; kind?: number; displayName?: string; documentation?: string[] }>;
      occurrences?: Array<{ symbol?: string; range: number[]; symbolRoles?: number }>;
    }> };

    let filesIngested = 0;
    let filesSkipped = 0;
    let symbolsIngested = 0;
    let occurrencesIngested = 0;

    // Prefix for converting SCIP-relative paths to repo-root-relative paths
    const pathPrefix = projectRoot ? projectRoot.replace(/\/$/, "") + "/" : "";

    // In-memory symbol cache — avoids per-occurrence SELECTs
    const symbolCache = new Map<string, SymbolRecord>();

    const fileHashes = options?.fileHashes;

    const doIngest = () => {

    for (const doc of idx.documents || []) {
      const filePath = pathPrefix + doc.relativePath;
      const existingFile = store.getFile(filePath);

      // Skip unchanged files when caller provides content hashes
      if (fileHashes && existingFile) {
        const currentHash = fileHashes.get(filePath);
        if (currentHash && currentHash === existingFile.hash) {
          filesSkipped++;
          continue;
        }
      }

      store.upsertFile({
        path: filePath,
        language: doc.language || "unknown",
        hash: fileHashes?.get(filePath) ?? existingFile?.hash ?? "",
      });
      store.clearOccurrencesForFile(filePath);
      store.clearSemanticEdgesForFile(filePath);
      filesIngested++;

      // Process symbol information (documentation, kinds) — batch upsert
      const docSymbols = doc.symbols || [];
      const symbolRecords: SymbolRecord[] = [];
      for (const sym of docSymbols) {
        const record: SymbolRecord = {
          id: sym.symbol,
          kind: scipKindToString(sym.kind) ?? inferKindFromSymbol(sym.symbol),
          name: sym.displayName || extractSymbolName(sym.symbol),
          file_path: filePath,
          doc: sym.documentation?.join("\n"),
        };
        symbolRecords.push(record);
        symbolCache.set(sym.symbol, record);
      }
      store.upsertSymbols(symbolRecords);
      symbolsIngested += symbolRecords.length;

      // Accumulate edges and occurrences per document, flush once at end
      const pendingEdges: EdgeRecord[] = [];
      const pendingOccurrences: OccurrenceRecord[] = [];
      // Definition symbols discovered during occurrence processing — upserted after
      const defSymbolUpdates: SymbolRecord[] = [];

      // Process occurrences (usages of symbols in this file)
      for (const occ of doc.occurrences || []) {
        if (!occ.symbol || occ.symbol.startsWith("local ")) continue;

        const range = decodeScipRange(occ.range);
        const packed = packRange(range);
        const roles = occ.symbolRoles || 0;

        pendingOccurrences.push({
          file_path: filePath,
          range_start: packed.start,
          range_end: packed.end,
          symbol_id: occ.symbol,
          roles,
        });

        if (roles & SymbolRole.Definition) {
          // Update the symbol record with its definition location
          const existing = symbolCache.get(occ.symbol) ?? store.getSymbol(occ.symbol);
          const updated: SymbolRecord = {
            id: occ.symbol,
            kind: existing?.kind ?? inferKindFromSymbol(occ.symbol),
            name: existing?.name || extractSymbolName(occ.symbol),
            file_path: filePath,
            range_start: packed.start,
            range_end: packed.end,
            doc: existing?.doc,
          };
          defSymbolUpdates.push(updated);
          symbolCache.set(occ.symbol, updated);
          pendingEdges.push({
            source: filePath,
            target: occ.symbol,
            kind: "defines",
            confidence: "high",
          });
        } else {
          pendingEdges.push({
            source: filePath,
            target: occ.symbol,
            kind: "references",
            confidence: "high",
          });
        }
      }

      // ── Derive approximate call edges ───────────────────────────────
      // Build sorted definition ranges from this document's occurrences
      const defRanges: { symbolId: string; start: number; end: number }[] = [];
      for (const occ of pendingOccurrences) {
        if (occ.roles & SymbolRole.Definition) {
          defRanges.push({ symbolId: occ.symbol_id, start: occ.range_start, end: occ.range_end });
        }
      }
      defRanges.sort((a, b) => a.start - b.start);

      // For each reference, find its enclosing definition and emit a "calls" edge
      const callEdgeKeys = new Set<string>();
      for (const occ of pendingOccurrences) {
        if (occ.roles & SymbolRole.Definition) continue;

        // Find innermost enclosing definition
        let enclosing: { symbolId: string; start: number } | null = null;
        for (const def of defRanges) {
          if (def.start <= occ.range_start && occ.range_end <= def.end) {
            if (!enclosing || def.start > enclosing.start) {
              enclosing = def;
            }
          }
        }

        if (enclosing && enclosing.symbolId !== occ.symbol_id) {
          const key = `${enclosing.symbolId}|${occ.symbol_id}`;
          if (!callEdgeKeys.has(key)) {
            callEdgeKeys.add(key);
            pendingEdges.push({
              source: enclosing.symbolId,
              target: occ.symbol_id,
              kind: "calls",
              confidence: "approximate",
            });
          }
        }
      }

      // Flush all batched operations for this document
      store.upsertOccurrences(pendingOccurrences);
      store.upsertSymbols(defSymbolUpdates);
      store.insertEdges(pendingEdges);
      occurrencesIngested += pendingOccurrences.length;
    }

    }; // end doIngest

    if (options?.bulk) {
      store.bulkTransaction(doIngest);
    } else {
      store.transaction(doIngest);
    }

    return { filesIngested, filesSkipped, symbolsIngested, occurrencesIngested };
  }
}
