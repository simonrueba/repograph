import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema";

export type RepographDB = Database;

export function createDatabase(path: string): RepographDB {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA_SQL);

  // Seed schema version if not set
  const existing = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!existing) {
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '3')");
  }

  return db;
}
