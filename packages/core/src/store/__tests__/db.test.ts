import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase } from "../db";

describe("createDatabase", () => {
  const tempDirs: string[] = [];

  function makeTempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "repograph-test-"));
    tempDirs.push(dir);
    return join(dir, "test.db");
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("should create all 5 tables", () => {
    const dbPath = makeTempDb();
    const db = createDatabase(dbPath);

    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name).sort();
    expect(tableNames).toEqual(
      ["edges", "files", "ledger", "occurrences", "symbols"].sort(),
    );

    db.close();
  });

  it("should create all expected indexes", () => {
    const dbPath = makeTempDb();
    const db = createDatabase(dbPath);

    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name).sort();
    expect(indexNames).toContain("idx_occurrences_symbol");
    expect(indexNames).toContain("idx_edges_source");
    expect(indexNames).toContain("idx_edges_target");
    expect(indexNames).toContain("idx_edges_kind");
    expect(indexNames).toContain("idx_symbols_name");
    expect(indexNames).toContain("idx_symbols_file");

    db.close();
  });

  it("should be idempotent — opening an existing DB works", () => {
    const dbPath = makeTempDb();

    // Create first time
    const db1 = createDatabase(dbPath);
    db1.exec(
      "INSERT INTO files (path, language, hash, indexed_at) VALUES ('a.ts', 'typescript', 'abc', 1)",
    );
    db1.close();

    // Open again — should NOT throw, schema already exists
    const db2 = createDatabase(dbPath);
    const row = db2.query("SELECT * FROM files WHERE path = 'a.ts'").get() as {
      path: string;
    } | null;
    expect(row).not.toBeNull();
    expect(row!.path).toBe("a.ts");

    db2.close();
  });

  it("should enable WAL journal mode", () => {
    const dbPath = makeTempDb();
    const db = createDatabase(dbPath);

    const result = db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(result.journal_mode).toBe("wal");

    db.close();
  });

  it("should return a usable Database instance", () => {
    const dbPath = makeTempDb();
    const db = createDatabase(dbPath);

    // Verify it has standard Database methods
    expect(typeof db.query).toBe("function");
    expect(typeof db.exec).toBe("function");
    expect(typeof db.close).toBe("function");

    db.close();
  });
});
