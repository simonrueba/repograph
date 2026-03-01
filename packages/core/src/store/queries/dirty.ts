import type { AriadneDB } from "../db";

export class DirtyQueries {
  constructor(private db: AriadneDB) {}

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
}
