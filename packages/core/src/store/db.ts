import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema";

export type RepographDB = Database;

const SCHEMA_VERSION = "5";

export function createDatabase(path: string): RepographDB {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA cache_size=-16000");
  db.exec("PRAGMA mmap_size=268435456");
  db.exec("PRAGMA temp_store=MEMORY");

  // Fast path: skip schema execution if version matches (warm DB open)
  try {
    const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null;
    if (row?.value === SCHEMA_VERSION) return db;
  } catch {
    // meta table doesn't exist yet — need full schema
  }

  db.exec(SCHEMA_SQL);
  db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`);

  return db;
}
