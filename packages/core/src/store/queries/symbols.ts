import type { AriadneDB } from "../db";
import type { SymbolRecord } from "../types";

export class SymbolQueries {
  constructor(private db: AriadneDB) {}

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

  getSymbolsByFile(filePath: string): SymbolRecord[] {
    return this.db
      .query(
        "SELECT id, kind, name, file_path, range_start, range_end, doc FROM symbols WHERE file_path = ?1",
      )
      .all(filePath) as SymbolRecord[];
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
}
