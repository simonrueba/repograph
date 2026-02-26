export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  language    TEXT NOT NULL,
  hash        TEXT NOT NULL,
  indexed_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id          TEXT PRIMARY KEY,
  kind        TEXT,
  name        TEXT NOT NULL,
  file_path   TEXT,
  range_start INTEGER,
  range_end   INTEGER,
  doc         TEXT
);

CREATE TABLE IF NOT EXISTS occurrences (
  file_path   TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end   INTEGER NOT NULL,
  symbol_id   TEXT NOT NULL,
  roles       INTEGER NOT NULL,
  PRIMARY KEY (file_path, range_start, symbol_id)
);

CREATE TABLE IF NOT EXISTS edges (
  source      TEXT NOT NULL,
  target      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  confidence  TEXT DEFAULT 'high'
);

CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   INTEGER NOT NULL,
  event       TEXT NOT NULL,
  data        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_occurrences_symbol ON occurrences(symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dirty (
  path       TEXT PRIMARY KEY,
  changed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id    TEXT PRIMARY KEY,
  root          TEXT NOT NULL,
  language      TEXT NOT NULL,
  last_index_ts INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Indexes on tables that are bulk-written during SCIP ingest.
 * These can be dropped before a full ingest and recreated after to avoid
 * per-row index maintenance overhead.
 */
export const INGEST_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_occurrences_symbol ON occurrences(symbol_id)",
  "CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source)",
  "CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target)",
  "CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind)",
  "CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)",
  "CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path)",
  "CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind)",
  "CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind)",
];

export const DROP_INGEST_INDEXES_SQL = [
  "DROP INDEX IF EXISTS idx_occurrences_symbol",
  "DROP INDEX IF EXISTS idx_edges_source",
  "DROP INDEX IF EXISTS idx_edges_target",
  "DROP INDEX IF EXISTS idx_edges_kind",
  "DROP INDEX IF EXISTS idx_symbols_name",
  "DROP INDEX IF EXISTS idx_symbols_file",
  "DROP INDEX IF EXISTS idx_edges_source_kind",
  "DROP INDEX IF EXISTS idx_edges_target_kind",
];
