import * as protobuf from "protobufjs";
import { join } from "path";
import { decodeScipRange, packRange, SymbolRole } from "./types";
import type { StoreQueries } from "../store/queries";

/**
 * Extract a human-readable name from a SCIP symbol string.
 *
 * SCIP symbol format:
 *   "scip-typescript npm repograph-core 0.1.0 src/store/`db.ts`/createDatabase()."
 *   "scip-typescript npm repograph-core 0.1.0 src/store/`queries.ts`/StoreQueries#"
 *   "scip-typescript npm repograph-core 0.1.0 src/store/`queries.ts`/StoreQueries#upsertFile()."
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
 */
function scipKindToString(kind?: number): string | undefined {
  const kinds: Record<number, string> = {
    2: "class",
    3: "method",
    4: "variable",
    5: "function",
    6: "interface",
    7: "module",
    8: "type",
    9: "enum",
    10: "enum_member",
    11: "property",
    12: "parameter",
  };
  return kind ? kinds[kind] : undefined;
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
   */
  ingest(
    index: any,
    store: StoreQueries,
    _repoRoot: string,
  ): {
    filesIngested: number;
    symbolsIngested: number;
    occurrencesIngested: number;
  } {
    let filesIngested = 0;
    let symbolsIngested = 0;
    let occurrencesIngested = 0;

    for (const doc of index.documents || []) {
      const filePath = doc.relativePath;
      const existingFile = store.getFile(filePath);
      store.upsertFile({
        path: filePath,
        language: doc.language || "unknown",
        hash: existingFile?.hash || "",
      });
      store.clearOccurrencesForFile(filePath);
      filesIngested++;

      // Process symbol information (documentation, kinds)
      for (const sym of doc.symbols || []) {
        store.upsertSymbol({
          id: sym.symbol,
          kind: scipKindToString(sym.kind),
          name: sym.displayName || extractSymbolName(sym.symbol),
          file_path: filePath,
          doc: sym.documentation?.join("\n"),
        });
        symbolsIngested++;
      }

      // Process occurrences (usages of symbols in this file)
      for (const occ of doc.occurrences || []) {
        if (!occ.symbol || occ.symbol.startsWith("local ")) continue;

        const range = decodeScipRange(occ.range);
        const packed = packRange(range);
        const roles = occ.symbolRoles || 0;

        store.upsertOccurrence({
          file_path: filePath,
          range_start: packed.start,
          range_end: packed.end,
          symbol_id: occ.symbol,
          roles,
        });
        occurrencesIngested++;

        if (roles & SymbolRole.Definition) {
          // Update the symbol record with its definition location
          const existing = store.getSymbol(occ.symbol);
          store.upsertSymbol({
            id: occ.symbol,
            kind: existing?.kind,
            name: existing?.name || extractSymbolName(occ.symbol),
            file_path: filePath,
            range_start: packed.start,
            range_end: packed.end,
            doc: existing?.doc,
          });
          store.insertEdge({
            source: filePath,
            target: occ.symbol,
            kind: "defines",
            confidence: "high",
          });
        } else {
          store.insertEdge({
            source: filePath,
            target: occ.symbol,
            kind: "references",
            confidence: "high",
          });
        }
      }
    }

    return { filesIngested, symbolsIngested, occurrencesIngested };
  }
}
