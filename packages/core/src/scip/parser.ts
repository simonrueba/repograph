import * as protobuf from "protobufjs";
import { join } from "path";
import { decodeScipRange, packRange, SymbolRole } from "./types";
import type { StoreQueries } from "../store/queries";

/**
 * Extract a human-readable name from a SCIP symbol string.
 *
 * SCIP symbols look like:
 *   "scip-typescript npm @types/node 18.0.0 fs/`readFileSync`()."
 *   "npm . pkg . MyClass#"
 *
 * Strategy: split on spaces, slashes, and dots, then look for backtick-quoted
 * descriptors first (these are the actual identifiers), falling back to the
 * last non-trivial segment.
 */
function extractSymbolName(scipSymbol: string): string {
  // First try to find backtick-quoted names (SCIP descriptor syntax)
  const backtickMatch = scipSymbol.match(/`([^`]+)`/g);
  if (backtickMatch && backtickMatch.length > 0) {
    // Take the last backtick-quoted name and strip backticks
    const last = backtickMatch[backtickMatch.length - 1];
    return last.replace(/`/g, "");
  }

  // Fallback: split on delimiters and pick the last meaningful part
  const parts = scipSymbol.split(/[\s./]/);
  const last = parts
    .filter(
      (p) =>
        p.length > 0 &&
        p !== "#" &&
        p !== "()" &&
        !p.match(/^\d+\.\d+\.\d+$/), // skip version numbers
    )
    .pop();
  return last?.replace(/[()#]/g, "") || scipSymbol;
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
      store.upsertFile({
        path: filePath,
        language: doc.language || "unknown",
        hash: "",
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
