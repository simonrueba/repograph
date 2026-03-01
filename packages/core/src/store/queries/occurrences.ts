import type { AriadneDB } from "../db";
import type { OccurrenceRecord } from "../types";

export class OccurrenceQueries {
  constructor(private db: AriadneDB) {}

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

  clearAllOccurrences(): void {
    this.db.exec("DELETE FROM occurrences");
  }
}
