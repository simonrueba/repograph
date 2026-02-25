// repograph-core — public API

// ── Store ────────────────────────────────────────────────────────────────
export { createDatabase } from "./store/db";
export type { RepographDB } from "./store/db";
export { SCHEMA_SQL } from "./store/schema";
export { StoreQueries } from "./store/queries";
export type {
  FileRecord,
  SymbolRecord,
  OccurrenceRecord,
  EdgeRecord,
} from "./store/queries";

// ── Ledger ───────────────────────────────────────────────────────────────
export { Ledger } from "./ledger/ledger";
export type { LedgerEntry } from "./ledger/ledger";

// ── SCIP ─────────────────────────────────────────────────────────────────
export { ScipParser } from "./scip/parser";
export { SymbolRole, decodeScipRange, packRange } from "./scip/types";
export type { ScipRange } from "./scip/types";

// ── Graph ────────────────────────────────────────────────────────────────
export { GraphQueries } from "./graph/refs";
export type { SymbolResult, DefResult, RefResult } from "./graph/refs";
export { ImpactAnalyzer } from "./graph/impact";
export type { ImpactResult } from "./graph/impact";
export { ModuleGraph } from "./graph/modules";
export type { ModuleGraphResult } from "./graph/modules";

// ── Verify ───────────────────────────────────────────────────────────────
export { VerifyEngine } from "./verify/engine";
export type { VerifyReport } from "./verify/engine";

// ── Indexers ─────────────────────────────────────────────────────────────
export { extractImports, resolveModulePath } from "./indexers/import-extractor";
export type { ImportEntry } from "./indexers/import-extractor";
export { ScipTypescriptIndexer } from "./indexers/scip-typescript";
export { ScipPythonIndexer } from "./indexers/scip-python";
export type { Indexer, IndexResult } from "./indexers/types";
