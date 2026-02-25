import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema";

export type RepographDB = Database;

export function createDatabase(path: string): RepographDB {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA_SQL);
  return db;
}
