import type { RepographDB } from "./db";

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

  searchSymbols(query: string): SymbolRecord[] {
    return this.db
      .query(
        "SELECT id, kind, name, file_path, range_start, range_end, doc FROM symbols WHERE name LIKE ?1",
      )
      .all(`%${query}%`) as SymbolRecord[];
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

  clearEdgesForFile(source: string): void {
    this.db.query("DELETE FROM edges WHERE source = ?1").run(source);
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
