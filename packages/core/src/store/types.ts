// ── Record types ─────────────────────────────────────────────────────
// Extracted from queries.ts to break the cycle between the facade
// and the focused query classes.

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
