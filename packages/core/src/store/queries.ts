import type { AriadneDB } from "./db";
import { INGEST_INDEXES_SQL, DROP_INGEST_INDEXES_SQL } from "./schema";
import { FileQueries } from "./queries/files";
import { SymbolQueries } from "./queries/symbols";
import { OccurrenceQueries } from "./queries/occurrences";
import { EdgeQueries } from "./queries/edges";
import { MetaQueries } from "./queries/meta";
import { DirtyQueries } from "./queries/dirty";
import { ProjectQueries } from "./queries/projects";

// Re-export record types from the shared types module (backward-compatible)
export type {
  FileRecord,
  SymbolRecord,
  OccurrenceRecord,
  EdgeRecord,
  ProjectRecord,
} from "./types";

import type { FileRecord, SymbolRecord, OccurrenceRecord, EdgeRecord, ProjectRecord } from "./types";

// ── Query layer (facade) ────────────────────────────────────────────

/**
 * Backward-compatible facade that delegates to focused query classes.
 *
 * All 28+ consumers continue to work unchanged. The focused classes
 * (e.g. `store.files`, `store.symbols`) are available as optional
 * direct imports for new code or gradual migration.
 */
export class StoreQueries {
  readonly files: FileQueries;
  readonly symbols: SymbolQueries;
  readonly occurrences: OccurrenceQueries;
  readonly edges: EdgeQueries;
  readonly meta: MetaQueries;
  readonly dirty: DirtyQueries;
  readonly projects: ProjectQueries;

  constructor(private db: AriadneDB) {
    this.files = new FileQueries(db);
    this.symbols = new SymbolQueries(db);
    this.occurrences = new OccurrenceQueries(db);
    this.edges = new EdgeQueries(db);
    this.meta = new MetaQueries(db);
    this.dirty = new DirtyQueries(db);
    this.projects = new ProjectQueries(db);
  }

  // ── Cross-cutting (stay on facade) ────────────────────────────────

  /** Run a callback inside a BEGIN/COMMIT transaction. Rolls back on error. */
  transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Run a bulk-ingest transaction with optimized pragmas and deferred indexes.
   *
   * - Sets `synchronous = OFF` for the duration (safe: a failed ingest can be re-run)
   * - Drops ingest-related indexes before the work, recreates them after
   * - Wraps the callback in a BEGIN/COMMIT transaction
   * - Restores `synchronous = NORMAL` on exit (even on error)
   */
  bulkTransaction(fn: () => void): void {
    this.db.exec("PRAGMA synchronous = OFF");
    for (const sql of DROP_INGEST_INDEXES_SQL) this.db.exec(sql);
    try {
      this.transaction(fn);
    } finally {
      for (const sql of INGEST_INDEXES_SQL) this.db.exec(sql);
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
  }

  /** Bulk clear all symbols (cross-cutting convenience). */
  clearAllSymbols(): void {
    this.db.exec("DELETE FROM symbols");
  }

  // ── Files (delegates to FileQueries) ──────────────────────────────

  upsertFile(file: Omit<FileRecord, "indexed_at">): void { return this.files.upsertFile(file); }
  getFile(path: string): FileRecord | null { return this.files.getFile(path); }
  getAllFiles(): FileRecord[] { return this.files.getAllFiles(); }
  getFilePaths(): Set<string> { return this.files.getFilePaths(); }
  getFileCount(): number { return this.files.getFileCount(); }
  getLastIndexedAt(): number { return this.files.getLastIndexedAt(); }
  findStaleFiles(entries: { path: string; hash: string }[]): string[] { return this.files.findStaleFiles(entries); }
  deleteFile(path: string): void { return this.files.deleteFile(path); }
  getFilesBatch(paths: string[]): Map<string, FileRecord> { return this.files.getFilesBatch(paths); }

  // ── Symbols (delegates to SymbolQueries) ──────────────────────────

  upsertSymbol(symbol: SymbolRecord): void { return this.symbols.upsertSymbol(symbol); }
  upsertSymbols(symbols: SymbolRecord[]): void { return this.symbols.upsertSymbols(symbols); }
  getSymbol(id: string): SymbolRecord | null { return this.symbols.getSymbol(id); }
  searchSymbols(query: string, k = 50): SymbolRecord[] { return this.symbols.searchSymbols(query, k); }
  getSymbolsBatch(ids: string[]): Map<string, SymbolRecord> { return this.symbols.getSymbolsBatch(ids); }
  getSymbolsByFile(filePath: string): SymbolRecord[] { return this.symbols.getSymbolsByFile(filePath); }
  getSymbolCount(): number { return this.symbols.getSymbolCount(); }
  getSymbolFileMap(): Map<string, string> { return this.symbols.getSymbolFileMap(); }

  // ── Occurrences (delegates to OccurrenceQueries) ──────────────────

  upsertOccurrence(occ: OccurrenceRecord): void { return this.occurrences.upsertOccurrence(occ); }
  upsertOccurrences(occs: OccurrenceRecord[]): void { return this.occurrences.upsertOccurrences(occs); }
  getOccurrencesBySymbol(symbolId: string): OccurrenceRecord[] { return this.occurrences.getOccurrencesBySymbol(symbolId); }
  getOccurrencesByFile(filePath: string): OccurrenceRecord[] { return this.occurrences.getOccurrencesByFile(filePath); }
  clearOccurrencesForFile(filePath: string): void { return this.occurrences.clearOccurrencesForFile(filePath); }
  clearAllOccurrences(): void { return this.occurrences.clearAllOccurrences(); }

  // ── Edges (delegates to EdgeQueries) ──────────────────────────────

  insertEdge(edge: EdgeRecord): void { return this.edges.insertEdge(edge); }
  getEdgesBySource(source: string): EdgeRecord[] { return this.edges.getEdgesBySource(source); }
  getEdgesByTarget(target: string): EdgeRecord[] { return this.edges.getEdgesByTarget(target); }
  getEdgesByTargetBatch(targets: string[]): EdgeRecord[] { return this.edges.getEdgesByTargetBatch(targets); }
  insertEdges(edges: EdgeRecord[]): void { return this.edges.insertEdges(edges); }
  getImportEdges(): EdgeRecord[] { return this.edges.getImportEdges(); }
  getExportEdges(): EdgeRecord[] { return this.edges.getExportEdges(); }
  getCallees(symbolId: string): EdgeRecord[] { return this.edges.getCallees(symbolId); }
  getCallers(symbolId: string): EdgeRecord[] { return this.edges.getCallers(symbolId); }
  clearEdgesForFile(source: string): void { return this.edges.clearEdgesForFile(source); }
  clearSemanticEdgesForFile(filePath: string): void { return this.edges.clearSemanticEdgesForFile(filePath); }
  clearAllEdges(): void { return this.edges.clearAllEdges(); }

  // ── Meta (delegates to MetaQueries) ───────────────────────────────

  getMeta(key: string): string | null { return this.meta.getMeta(key); }
  setMeta(key: string, value: string): void { return this.meta.setMeta(key, value); }

  // ── Dirty (delegates to DirtyQueries) ─────────────────────────────

  markDirty(path: string): void { return this.dirty.markDirty(path); }
  clearDirty(path: string): void { return this.dirty.clearDirty(path); }
  clearAllDirty(): void { return this.dirty.clearAllDirty(); }
  clearDirtyByPrefix(prefix: string): void { return this.dirty.clearDirtyByPrefix(prefix); }
  getDirtyPaths(): { path: string; changed_at: number }[] { return this.dirty.getDirtyPaths(); }
  getDirtyCount(): number { return this.dirty.getDirtyCount(); }

  // ── Projects (delegates to ProjectQueries) ────────────────────────

  upsertProject(project: ProjectRecord): void { return this.projects.upsertProject(project); }
  getProject(projectId: string): ProjectRecord | null { return this.projects.getProject(projectId); }
  getAllProjects(): ProjectRecord[] { return this.projects.getAllProjects(); }
  setProjectIndexTs(projectId: string, ts: number): void { return this.projects.setProjectIndexTs(projectId, ts); }
  getProjectForPath(filePath: string): ProjectRecord | null { return this.projects.getProjectForPath(filePath); }
}
