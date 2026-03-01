import type { AriadneDB } from "../db";
import type { FileRecord } from "../types";

export class FileQueries {
  constructor(private db: AriadneDB) {}

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
}
