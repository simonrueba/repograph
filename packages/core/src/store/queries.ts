import type { RepographDB } from "./db";
import { INGEST_INDEXES_SQL, DROP_INGEST_INDEXES_SQL } from "./schema";

// ── Record types ─────────────────────────────────────────────────────

export interface FileRecord {
  path: string;
  language: string;
  hash: string;
  indexed_at?: number;
}

export interface SymbolRecord {
  id: string;
  kind?: string;
  name: string;
  file_path?: string;
  range_start?: number;
  range_end?: number;
  doc?: string;
}

export interface OccurrenceRecord {
  file_path: string;
  range_start: number;
  range_end: number;
  symbol_id: string;
  roles: number;
}

export interface EdgeRecord {
  source: string;
  target: string;
  kind: string;
  confidence?: string;
}

export interface ProjectRecord {
  project_id: string;
  root: string;
  language: string;
  last_index_ts: number;
}

// ── Query layer ──────────────────────────────────────────────────────

export class StoreQueries {
  constructor(private db: RepographDB) {}

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

  // ── Files ────────────────────────────────────────────────────────

  upsertFile(file: Omit<FileRecord, "indexed_at">): void {
    this.db
      .query(
        `INSERT INTO files (path, language, hash, indexed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET
           language   = excluded.language,
           hash       = excluded.hash,
           indexed_at = excluded.indexed_at`,
      )
      .run(file.path, file.language, file.hash, Date.now());
  }

  getFile(path: string): FileRecord | null {
    return (
      (this.db
        .query("SELECT path, language, hash, indexed_at FROM files WHERE path = ?1")
        .get(path) as FileRecord | null) ?? null
    );
  }

  getAllFiles(): FileRecord[] {
    return this.db
      .query("SELECT path, language, hash, indexed_at FROM files")
      .all() as FileRecord[];
  }

  /** Lightweight query returning only file paths (no hash/language/timestamp). */
  getFilePaths(): Set<string> {
    const rows = this.db
      .query("SELECT path FROM files")
      .all() as { path: string }[];
    return new Set(rows.map((r) => r.path));
  }

  getFileCount(): number {
    return (
      this.db.query("SELECT COUNT(*) as count FROM files").get() as { count: number }
    ).count;
  }

  getLastIndexedAt(): number {
    const row = this.db
      .query("SELECT MAX(indexed_at) as max_ts FROM files")
      .get() as { max_ts: number | null } | null;
    return row?.max_ts ?? 0;
  }

  findStaleFiles(entries: { path: string; hash: string }[]): string[] {
    const stale: string[] = [];
    const stmt = this.db.query("SELECT hash FROM files WHERE path = ?1");

    for (const entry of entries) {
      const row = stmt.get(entry.path) as { hash: string } | null;
      if (row === null || row.hash !== entry.hash) {
        stale.push(entry.path);
      }
    }

    return stale;
  }

  deleteFile(path: string): void {
    this.db.query("DELETE FROM files WHERE path = ?1").run(path);
  }

  // ── Symbols ──────────────────────────────────────────────────────

  upsertSymbol(symbol: SymbolRecord): void {
    this.db
      .query(
        `INSERT INTO symbols (id, kind, name, file_path, range_start, range_end, doc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           kind        = excluded.kind,
           name        = excluded.name,
           file_path   = excluded.file_path,
           range_start = excluded.range_start,
           range_end   = excluded.range_end,
           doc         = excluded.doc`,
      )
      .run(
        symbol.id,
        symbol.kind ?? null,
        symbol.name,
        symbol.file_path ?? null,
        symbol.range_start ?? null,
        symbol.range_end ?? null,
        symbol.doc ?? null,
      );
  }

  /**
   * Batch-upsert symbols using a single cached prepared statement.
   */
  upsertSymbols(symbols: SymbolRecord[]): void {
    if (symbols.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO symbols (id, kind, name, file_path, range_start, range_end, doc)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
         kind        = excluded.kind,
         name        = excluded.name,
         file_path   = excluded.file_path,
         range_start = excluded.range_start,
         range_end   = excluded.range_end,
         doc         = excluded.doc`,
    );
    for (const s of symbols) {
      stmt.run(
        s.id,
        s.kind ?? null,
        s.name,
        s.file_path ?? null,
        s.range_start ?? null,
        s.range_end ?? null,
        s.doc ?? null,
      );
    }
  }

  getSymbol(id: string): SymbolRecord | null {
    return (
      (this.db
        .query(
          "SELECT id, kind, name, file_path, range_start, range_end, doc FROM symbols WHERE id = ?1",
        )
        .get(id) as SymbolRecord | null) ?? null
    );
  }

  searchSymbols(query: string, k = 50): SymbolRecord[] {
    // Fast path: prefix match (can use index on name column)
    const prefixResults = this.db
      .query(
        "SELECT id, kind, name, file_path, range_start, range_end, doc FROM symbols WHERE name LIKE ?1 LIMIT ?2",
      )
      .all(`${query}%`, k) as SymbolRecord[];

    if (prefixResults.length >= k) return prefixResults;

    // Fallback: substring match (full scan, but bounded by LIMIT)
    return this.db
      .query(
        "SELECT id, kind, name, file_path, range_start, range_end, doc FROM symbols WHERE name LIKE ?1 LIMIT ?2",
      )
      .all(`%${query}%`, k) as SymbolRecord[];
  }

  /**
   * Batch-fetch symbols by IDs. Returns a Map for O(1) lookup.
   * Uses a single query with IN clause instead of N individual queries.
   */
  getSymbolsBatch(ids: string[]): Map<string, SymbolRecord> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT id, kind, name, file_path, range_start, range_end, doc FROM symbols WHERE id IN (${placeholders})`,
      )
      .all(...ids) as SymbolRecord[];
    const map = new Map<string, SymbolRecord>();
    for (const row of rows) {
      map.set(row.id, row);
    }
    return map;
  }

  /**
   * Batch-fetch files by paths. Returns a Map for O(1) lookup.
   * Uses a cached prepared statement in a loop (faster than dynamic IN clause
   * which forces SQLite to recompile for each unique placeholder count).
   */
  getFilesBatch(paths: string[]): Map<string, FileRecord> {
    if (paths.length === 0) return new Map();
    const stmt = this.db.query(
      "SELECT path, language, hash, indexed_at FROM files WHERE path = ?1",
    );
    const map = new Map<string, FileRecord>();
    for (const p of paths) {
      const row = stmt.get(p) as FileRecord | null;
      if (row) map.set(row.path, row);
    }
    return map;
  }

  getSymbolsByFile(filePath: string): SymbolRecord[] {
    return this.db
      .query(
        "SELECT id, kind, name, file_path, range_start, range_end, doc FROM symbols WHERE file_path = ?1",
      )
      .all(filePath) as SymbolRecord[];
  }

  // ── Occurrences ──────────────────────────────────────────────────

  upsertOccurrence(occ: OccurrenceRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO occurrences (file_path, range_start, range_end, symbol_id, roles)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .run(occ.file_path, occ.range_start, occ.range_end, occ.symbol_id, occ.roles);
  }

  /**
   * Batch-upsert occurrences using a single cached prepared statement.
   */
  upsertOccurrences(occs: OccurrenceRecord[]): void {
    if (occs.length === 0) return;
    const stmt = this.db.query(
      `INSERT OR REPLACE INTO occurrences (file_path, range_start, range_end, symbol_id, roles)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    );
    for (const occ of occs) {
      stmt.run(occ.file_path, occ.range_start, occ.range_end, occ.symbol_id, occ.roles);
    }
  }

  getOccurrencesBySymbol(symbolId: string): OccurrenceRecord[] {
    return this.db
      .query(
        "SELECT file_path, range_start, range_end, symbol_id, roles FROM occurrences WHERE symbol_id = ?1",
      )
      .all(symbolId) as OccurrenceRecord[];
  }

  getOccurrencesByFile(filePath: string): OccurrenceRecord[] {
    return this.db
      .query(
        "SELECT file_path, range_start, range_end, symbol_id, roles FROM occurrences WHERE file_path = ?1",
      )
      .all(filePath) as OccurrenceRecord[];
  }

  clearOccurrencesForFile(filePath: string): void {
    this.db
      .query("DELETE FROM occurrences WHERE file_path = ?1")
      .run(filePath);
  }

  // ── Edges ────────────────────────────────────────────────────────

  insertEdge(edge: EdgeRecord): void {
    this.db
      .query(
        `INSERT INTO edges (source, target, kind, confidence)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .run(edge.source, edge.target, edge.kind, edge.confidence ?? "high");
  }

  getEdgesBySource(source: string): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE source = ?1",
      )
      .all(source) as EdgeRecord[];
  }

  getEdgesByTarget(target: string): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE target = ?1",
      )
      .all(target) as EdgeRecord[];
  }

  /**
   * Batch-fetch edges by multiple targets using a cached prepared statement.
   * Uses stmt loop instead of dynamic IN clause (avoids recompilation per unique count).
   */
  getEdgesByTargetBatch(targets: string[]): EdgeRecord[] {
    if (targets.length === 0) return [];
    const stmt = this.db.query(
      "SELECT source, target, kind, confidence FROM edges WHERE target = ?1",
    );
    const results: EdgeRecord[] = [];
    for (const t of targets) {
      const rows = stmt.all(t) as EdgeRecord[];
      results.push(...rows);
    }
    return results;
  }

  /**
   * Batch-insert edges using a single cached prepared statement.
   * Bun SQLite caches compiled statements, making stmt.run() in a loop
   * faster than multi-row INSERT (which rebuilds SQL per chunk).
   */
  insertEdges(edges: EdgeRecord[]): void {
    if (edges.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO edges (source, target, kind, confidence)
       VALUES (?1, ?2, ?3, ?4)`,
    );
    for (const edge of edges) {
      stmt.run(edge.source, edge.target, edge.kind, edge.confidence ?? "high");
    }
  }

  /** Fetch all import edges in a single query. */
  getImportEdges(): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE kind = 'imports'",
      )
      .all() as EdgeRecord[];
  }

  /** Fetch all export edges in a single query. */
  getExportEdges(): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE kind = 'exports'",
      )
      .all() as EdgeRecord[];
  }

  getCallees(symbolId: string): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE source = ?1 AND kind = 'calls'",
      )
      .all(symbolId) as EdgeRecord[];
  }

  getCallers(symbolId: string): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE target = ?1 AND kind = 'calls'",
      )
      .all(symbolId) as EdgeRecord[];
  }

  clearEdgesForFile(source: string): void {
    this.db.query("DELETE FROM edges WHERE source = ?1").run(source);
  }

  /**
   * Clear semantic edges produced by SCIP ingestion for a specific file.
   * - Deletes `defines` and `references` edges where `source = filePath`
   * - Deletes `calls` edges originating from symbols defined in this file
   *
   * This prevents edge bloat when re-ingesting the same file multiple times.
   */
  clearSemanticEdgesForFile(filePath: string): void {
    this.db
      .query("DELETE FROM edges WHERE source = ?1 AND kind IN ('defines', 'references')")
      .run(filePath);
    this.db
      .query(
        "DELETE FROM edges WHERE kind = 'calls' AND source IN (SELECT id FROM symbols WHERE file_path = ?1)",
      )
      .run(filePath);
  }

  clearAllEdges(): void {
    this.db.exec("DELETE FROM edges");
  }

  clearAllSymbols(): void {
    this.db.exec("DELETE FROM symbols");
  }

  clearAllOccurrences(): void {
    this.db.exec("DELETE FROM occurrences");
  }

  getSymbolCount(): number {
    return (
      this.db.query("SELECT COUNT(*) as count FROM symbols").get() as { count: number }
    ).count;
  }

  getSymbolFileMap(): Map<string, string> {
    const rows = this.db
      .query("SELECT id, file_path FROM symbols WHERE file_path IS NOT NULL")
      .all() as { id: string; file_path: string }[];
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.id, row.file_path);
    }
    return map;
  }

  // ── Meta ─────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db
      .query("SELECT value FROM meta WHERE key = ?1")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // ── Dirty set ──────────────────────────────────────────────────

  markDirty(path: string): void {
    this.db
      .query(
        `INSERT INTO dirty (path, changed_at) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET changed_at = excluded.changed_at`,
      )
      .run(path, Date.now());
  }

  clearDirty(path: string): void {
    this.db.query("DELETE FROM dirty WHERE path = ?1").run(path);
  }

  clearAllDirty(): void {
    this.db.exec("DELETE FROM dirty");
  }

  /**
   * Clear dirty flags only for files under a given path prefix (project root).
   * Used for per-project dirty clearing so a failed project doesn't lose
   * its dirty flags when a sibling project succeeds.
   */
  clearDirtyByPrefix(prefix: string): void {
    if (!prefix || prefix === "." || prefix === "") {
      this.clearAllDirty();
      return;
    }
    const normalized = prefix.endsWith("/") ? prefix : prefix + "/";
    this.db.query("DELETE FROM dirty WHERE path LIKE ?1").run(normalized + "%");
  }

  getDirtyPaths(): { path: string; changed_at: number }[] {
    return this.db
      .query("SELECT path, changed_at FROM dirty ORDER BY changed_at DESC")
      .all() as { path: string; changed_at: number }[];
  }

  getDirtyCount(): number {
    return (
      this.db.query("SELECT COUNT(*) as count FROM dirty").get() as { count: number }
    ).count;
  }

  // ── Projects ────────────────────────────────────────────────────

  upsertProject(project: ProjectRecord): void {
    this.db
      .query(
        `INSERT INTO projects (project_id, root, language, last_index_ts)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project_id) DO UPDATE SET
           root          = excluded.root,
           language      = excluded.language,
           last_index_ts = excluded.last_index_ts`,
      )
      .run(project.project_id, project.root, project.language, project.last_index_ts);
  }

  getProject(projectId: string): ProjectRecord | null {
    return (
      (this.db
        .query(
          "SELECT project_id, root, language, last_index_ts FROM projects WHERE project_id = ?1",
        )
        .get(projectId) as ProjectRecord | null) ?? null
    );
  }

  getAllProjects(): ProjectRecord[] {
    return this.db
      .query("SELECT project_id, root, language, last_index_ts FROM projects")
      .all() as ProjectRecord[];
  }

  setProjectIndexTs(projectId: string, ts: number): void {
    this.db
      .query(
        `UPDATE projects SET last_index_ts = ?2 WHERE project_id = ?1`,
      )
      .run(projectId, ts);
  }

  /**
   * Find the project whose `root` is the longest prefix of `filePath`.
   * Returns the most specific (deepest) match, or null if none match.
   */
  getProjectForPath(filePath: string): ProjectRecord | null {
    const projects = this.getAllProjects();
    let best: ProjectRecord | null = null;
    let bestLen = -1;

    for (const project of projects) {
      const root = project.root.endsWith("/") ? project.root : project.root + "/";
      if (filePath.startsWith(root) || filePath === project.root) {
        if (project.root.length > bestLen) {
          bestLen = project.root.length;
          best = project;
        }
      }
    }

    return best;
  }
}
