# Ariadne Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a CLI tool + MCP server that indexes a repo into a semantic dependency graph and gates agent completion via verification.

**Architecture:** Bun workspaces monorepo with three packages (core, cli, mcp). CLI-first — no daemon. SCIP indexers run as subprocesses, results parsed into SQLite. MCP server wraps core library over stdio transport.

**Tech Stack:** Bun, TypeScript, bun:sqlite (built-in), protobufjs (SCIP parsing), @modelcontextprotocol/sdk, vitest

**Design adjustment:** Use `bun:sqlite` instead of `better-sqlite3` — it's built into the Bun runtime, zero dependencies, 3-6x faster.

---

## Task 1: Monorepo Scaffold

**Files:**
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.json`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/tsconfig.json`
- Create: `packages/mcp/src/index.ts`
- Create: `.gitignore`
- Create: `vitest.config.ts`

**Step 1: Create root package.json with Bun workspaces**

```json
{
  "name": "ariadne",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest",
    "build": "bun run --filter '*' build",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Create bunfig.toml**

```toml
[install]
peer = false
```

**Step 3: Create root tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["bun-types"]
  }
}
```

**Step 4: Create packages/core/package.json**

```json
{
  "name": "ariadne-core",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun",
    "test": "vitest run"
  },
  "dependencies": {
    "protobufjs": "^7.4.0"
  },
  "devDependencies": {
    "bun-types": "latest"
  }
}
```

**Step 5: Create packages/cli/package.json**

```json
{
  "name": "ariadne-cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "ariadne": "src/index.ts"
  },
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun",
    "test": "vitest run"
  },
  "dependencies": {
    "ariadne-core": "workspace:*"
  },
  "devDependencies": {
    "bun-types": "latest"
  }
}
```

**Step 6: Create packages/mcp/package.json**

```json
{
  "name": "ariadne-mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "start": "bun run src/index.ts",
    "build": "bun build src/index.ts --outdir dist --target bun",
    "test": "vitest run"
  },
  "dependencies": {
    "ariadne-core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.27.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "bun-types": "latest"
  }
}
```

**Step 7: Create minimal entry files, tsconfigs, .gitignore, vitest config**

Each package gets a `tsconfig.json` extending root, a stub `src/index.ts` exporting nothing.

`.gitignore`:
```
node_modules/
dist/
.ariadne/
*.scip
```

`vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/__tests__/**/*.test.ts"],
  },
});
```

**Step 8: Install dependencies and verify**

Run: `bun install`
Run: `bun test` (should pass with 0 tests)
Run: `bun run typecheck` (should pass)

**Step 9: Commit**

```bash
git add -A && git commit -m "feat: scaffold bun workspaces monorepo"
```

---

## Task 2: SQLite Store — Schema & DB Setup

**Files:**
- Create: `packages/core/src/store/db.ts`
- Create: `packages/core/src/store/schema.ts`
- Test: `packages/core/src/store/__tests__/db.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/core/src/store/__tests__/db.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, type RepographDB } from "../db";
import { rmSync, mkdirSync } from "fs";

describe("createDatabase", () => {
  const testDir = "/tmp/ariadne-test-db";

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates SQLite database with all tables", () => {
    const db = createDatabase(`${testDir}/index.db`);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("files");
    expect(tableNames).toContain("symbols");
    expect(tableNames).toContain("occurrences");
    expect(tableNames).toContain("edges");
    expect(tableNames).toContain("ledger");
    db.close();
  });

  it("creates indexes", () => {
    const db = createDatabase(`${testDir}/index.db`);
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_occurrences_symbol");
    expect(indexNames).toContain("idx_edges_source");
    expect(indexNames).toContain("idx_edges_target");
    db.close();
  });

  it("is idempotent (can open existing DB)", () => {
    const db1 = createDatabase(`${testDir}/index.db`);
    db1.close();
    const db2 = createDatabase(`${testDir}/index.db`);
    expect(db2).toBeDefined();
    db2.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/store/__tests__/db.test.ts`
Expected: FAIL — module not found

**Step 3: Write schema.ts**

```typescript
// packages/core/src/store/schema.ts
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
`;
```

**Step 4: Write db.ts**

```typescript
// packages/core/src/store/db.ts
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
```

**Step 5: Run test to verify it passes**

Run: `bun test packages/core/src/store/__tests__/db.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/src/store/ && git commit -m "feat(core): add SQLite store with schema"
```

---

## Task 3: SQLite Store — Query Layer

**Files:**
- Create: `packages/core/src/store/queries.ts`
- Test: `packages/core/src/store/__tests__/queries.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/core/src/store/__tests__/queries.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, type RepographDB } from "../db";
import { StoreQueries } from "../queries";
import { rmSync, mkdirSync } from "fs";

describe("StoreQueries", () => {
  const testDir = "/tmp/ariadne-test-queries";
  let db: RepographDB;
  let queries: StoreQueries;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    db = createDatabase(`${testDir}/index.db`);
    queries = new StoreQueries(db);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("files", () => {
    it("upserts and retrieves a file", () => {
      queries.upsertFile({ path: "src/main.ts", language: "typescript", hash: "abc123" });
      const file = queries.getFile("src/main.ts");
      expect(file).toMatchObject({ path: "src/main.ts", language: "typescript", hash: "abc123" });
      expect(file!.indexed_at).toBeGreaterThan(0);
    });

    it("returns null for missing file", () => {
      expect(queries.getFile("nope.ts")).toBeNull();
    });

    it("lists stale files (hash mismatch)", () => {
      queries.upsertFile({ path: "src/a.ts", language: "typescript", hash: "old" });
      const stale = queries.findStaleFiles([{ path: "src/a.ts", hash: "new" }]);
      expect(stale).toEqual(["src/a.ts"]);
    });
  });

  describe("symbols", () => {
    it("upserts and retrieves a symbol", () => {
      queries.upsertSymbol({
        id: "npm pkg . `createUser`.",
        kind: "function",
        name: "createUser",
        file_path: "src/user.ts",
        range_start: (10 << 16) | 0,
        range_end: (10 << 16) | 20,
      });
      const sym = queries.getSymbol("npm pkg . `createUser`.");
      expect(sym).toMatchObject({ name: "createUser", kind: "function" });
    });

    it("searches symbols by name prefix", () => {
      queries.upsertSymbol({ id: "s1", kind: "function", name: "createUser", file_path: "a.ts" });
      queries.upsertSymbol({ id: "s2", kind: "function", name: "createOrder", file_path: "b.ts" });
      queries.upsertSymbol({ id: "s3", kind: "class", name: "UserService", file_path: "c.ts" });
      const results = queries.searchSymbols("create", 10);
      expect(results).toHaveLength(2);
    });
  });

  describe("occurrences", () => {
    it("inserts and queries by symbol", () => {
      queries.upsertOccurrence({
        file_path: "src/api.ts",
        range_start: (5 << 16) | 2,
        range_end: (5 << 16) | 12,
        symbol_id: "s1",
        roles: 2,
      });
      const occs = queries.getOccurrencesBySymbol("s1");
      expect(occs).toHaveLength(1);
      expect(occs[0].file_path).toBe("src/api.ts");
    });
  });

  describe("edges", () => {
    it("inserts and queries by source", () => {
      queries.insertEdge({ source: "src/a.ts", target: "s1", kind: "defines", confidence: "high" });
      const edges = queries.getEdgesBySource("src/a.ts");
      expect(edges).toHaveLength(1);
      expect(edges[0].kind).toBe("defines");
    });

    it("queries by target (reverse deps)", () => {
      queries.insertEdge({ source: "src/a.ts", target: "mod-b", kind: "imports", confidence: "medium" });
      queries.insertEdge({ source: "src/c.ts", target: "mod-b", kind: "imports", confidence: "medium" });
      const importers = queries.getEdgesByTarget("mod-b");
      expect(importers).toHaveLength(2);
    });

    it("clears edges for a file", () => {
      queries.insertEdge({ source: "src/a.ts", target: "s1", kind: "defines" });
      queries.insertEdge({ source: "src/a.ts", target: "s2", kind: "references" });
      queries.clearEdgesForFile("src/a.ts");
      expect(queries.getEdgesBySource("src/a.ts")).toHaveLength(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/store/__tests__/queries.test.ts`
Expected: FAIL

**Step 3: Implement StoreQueries**

```typescript
// packages/core/src/store/queries.ts
import type { RepographDB } from "./db";

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

export class StoreQueries {
  constructor(private db: RepographDB) {}

  upsertFile(f: { path: string; language: string; hash: string }): void {
    this.db
      .query(
        `INSERT INTO files (path, language, hash, indexed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET language=?2, hash=?3, indexed_at=?4`
      )
      .run(f.path, f.language, f.hash, Date.now());
  }

  getFile(path: string): FileRecord | null {
    return this.db.query("SELECT * FROM files WHERE path = ?1").get(path) as FileRecord | null;
  }

  getAllFiles(): FileRecord[] {
    return this.db.query("SELECT * FROM files").all() as FileRecord[];
  }

  findStaleFiles(current: { path: string; hash: string }[]): string[] {
    const stale: string[] = [];
    const stmt = this.db.query("SELECT hash FROM files WHERE path = ?1");
    for (const { path, hash } of current) {
      const row = stmt.get(path) as { hash: string } | null;
      if (row && row.hash !== hash) stale.push(path);
      else if (!row) stale.push(path);
    }
    return stale;
  }

  deleteFile(path: string): void {
    this.db.query("DELETE FROM files WHERE path = ?1").run(path);
  }

  upsertSymbol(s: SymbolRecord): void {
    this.db
      .query(
        `INSERT INTO symbols (id, kind, name, file_path, range_start, range_end, doc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET kind=?2, name=?3, file_path=?4, range_start=?5, range_end=?6, doc=?7`
      )
      .run(s.id, s.kind ?? null, s.name, s.file_path ?? null, s.range_start ?? null, s.range_end ?? null, s.doc ?? null);
  }

  getSymbol(id: string): SymbolRecord | null {
    return this.db.query("SELECT * FROM symbols WHERE id = ?1").get(id) as SymbolRecord | null;
  }

  searchSymbols(query: string, k: number): SymbolRecord[] {
    return this.db
      .query("SELECT * FROM symbols WHERE name LIKE ?1 LIMIT ?2")
      .all(`%${query}%`, k) as SymbolRecord[];
  }

  upsertOccurrence(o: OccurrenceRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO occurrences (file_path, range_start, range_end, symbol_id, roles)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      )
      .run(o.file_path, o.range_start, o.range_end, o.symbol_id, o.roles);
  }

  getOccurrencesBySymbol(symbolId: string): OccurrenceRecord[] {
    return this.db
      .query("SELECT * FROM occurrences WHERE symbol_id = ?1")
      .all(symbolId) as OccurrenceRecord[];
  }

  getOccurrencesByFile(filePath: string): OccurrenceRecord[] {
    return this.db
      .query("SELECT * FROM occurrences WHERE file_path = ?1")
      .all(filePath) as OccurrenceRecord[];
  }

  clearOccurrencesForFile(filePath: string): void {
    this.db.query("DELETE FROM occurrences WHERE file_path = ?1").run(filePath);
  }

  insertEdge(e: EdgeRecord): void {
    this.db
      .query(`INSERT INTO edges (source, target, kind, confidence) VALUES (?1, ?2, ?3, ?4)`)
      .run(e.source, e.target, e.kind, e.confidence ?? "high");
  }

  getEdgesBySource(source: string): EdgeRecord[] {
    return this.db.query("SELECT * FROM edges WHERE source = ?1").all(source) as EdgeRecord[];
  }

  getEdgesByTarget(target: string): EdgeRecord[] {
    return this.db.query("SELECT * FROM edges WHERE target = ?1").all(target) as EdgeRecord[];
  }

  clearEdgesForFile(filePath: string): void {
    this.db.query("DELETE FROM edges WHERE source = ?1").run(filePath);
  }

  clearAllEdges(): void {
    this.db.query("DELETE FROM edges").run();
  }

  clearAllSymbols(): void {
    this.db.query("DELETE FROM symbols").run();
  }

  clearAllOccurrences(): void {
    this.db.query("DELETE FROM occurrences").run();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/store/__tests__/queries.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/store/ && git commit -m "feat(core): add store query layer"
```

---

## Task 4: Ledger (Append-Only Event Log)

**Files:**
- Create: `packages/core/src/ledger/ledger.ts`
- Test: `packages/core/src/ledger/__tests__/ledger.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/core/src/ledger/__tests__/ledger.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../store/db";
import { Ledger } from "../ledger";
import { rmSync, mkdirSync } from "fs";

describe("Ledger", () => {
  const testDir = "/tmp/ariadne-test-ledger";
  let ledger: Ledger;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    const db = createDatabase(`${testDir}/index.db`);
    ledger = new Ledger(db);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("logs and retrieves events", () => {
    ledger.log("edit", { file: "src/main.ts" });
    ledger.log("test_run", { command: "vitest run" });
    const all = ledger.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].event).toBe("edit");
    expect(all[1].event).toBe("test_run");
  });

  it("filters by event type", () => {
    ledger.log("edit", { file: "a.ts" });
    ledger.log("test_run", { command: "vitest" });
    ledger.log("edit", { file: "b.ts" });
    const edits = ledger.getByEvent("edit");
    expect(edits).toHaveLength(2);
  });

  it("gets latest event of a type", () => {
    ledger.log("edit", { file: "a.ts" });
    ledger.log("edit", { file: "b.ts" });
    const latest = ledger.getLatest("edit");
    expect(latest).toBeDefined();
    expect(JSON.parse(latest!.data).file).toBe("b.ts");
  });

  it("checks if test ran after last edit", () => {
    ledger.log("edit", { file: "a.ts" });
    expect(ledger.hasTestAfterLastEdit()).toBe(false);
    ledger.log("test_run", { command: "vitest" });
    expect(ledger.hasTestAfterLastEdit()).toBe(true);
  });
});
```

**Step 2: Implement Ledger**

```typescript
// packages/core/src/ledger/ledger.ts
import type { RepographDB } from "../store/db";

export interface LedgerEntry {
  id: number;
  timestamp: number;
  event: string;
  data: string;
}

export class Ledger {
  constructor(private db: RepographDB) {}

  log(event: string, data: Record<string, unknown>): void {
    this.db
      .query("INSERT INTO ledger (timestamp, event, data) VALUES (?1, ?2, ?3)")
      .run(Date.now(), event, JSON.stringify(data));
  }

  getAll(): LedgerEntry[] {
    return this.db.query("SELECT * FROM ledger ORDER BY id ASC").all() as LedgerEntry[];
  }

  getByEvent(event: string): LedgerEntry[] {
    return this.db.query("SELECT * FROM ledger WHERE event = ?1 ORDER BY id ASC").all(event) as LedgerEntry[];
  }

  getLatest(event: string): LedgerEntry | null {
    return this.db.query("SELECT * FROM ledger WHERE event = ?1 ORDER BY id DESC LIMIT 1").get(event) as LedgerEntry | null;
  }

  getAfter(timestamp: number): LedgerEntry[] {
    return this.db.query("SELECT * FROM ledger WHERE timestamp > ?1 ORDER BY id ASC").all(timestamp) as LedgerEntry[];
  }

  hasTestAfterLastEdit(): boolean {
    const lastEdit = this.getLatest("edit");
    if (!lastEdit) return true;
    const lastTest = this.getLatest("test_run");
    if (!lastTest) return false;
    return lastTest.id > lastEdit.id;
  }
}
```

**Step 3: Run test, verify pass, commit**

Run: `bun test packages/core/src/ledger/__tests__/ledger.test.ts`
```bash
git add packages/core/src/ledger/ && git commit -m "feat(core): add append-only ledger"
```

---

## Task 5: SCIP Protobuf Parser

**Files:**
- Create: `packages/core/src/scip/scip.proto` (copy from sourcegraph/scip repo)
- Create: `packages/core/src/scip/parser.ts`
- Create: `packages/core/src/scip/types.ts`
- Test: `packages/core/src/scip/__tests__/parser.test.ts`
- Test: `packages/core/src/scip/__tests__/parser-integration.test.ts`

**Step 1: Copy scip.proto**

Download from `https://raw.githubusercontent.com/sourcegraph/scip/main/scip.proto` and place at `packages/core/src/scip/scip.proto`.

**Step 2: Create types.ts**

```typescript
// packages/core/src/scip/types.ts
export const SymbolRole = {
  UnspecifiedSymbolRole: 0,
  Definition: 1,
  Import: 2,
  WriteAccess: 4,
  ReadAccess: 8,
  Generated: 16,
  Test: 32,
  ForwardDefinition: 64,
} as const;

export interface ScipRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export function decodeScipRange(range: number[]): ScipRange {
  if (range.length === 3) {
    return { startLine: range[0], startCol: range[1], endLine: range[0], endCol: range[2] };
  }
  return { startLine: range[0], startCol: range[1], endLine: range[2], endCol: range[3] };
}

export function packRange(r: ScipRange): { start: number; end: number } {
  return {
    start: (r.startLine << 16) | r.startCol,
    end: (r.endLine << 16) | r.endCol,
  };
}
```

**Step 3: Write unit test for types**

```typescript
// packages/core/src/scip/__tests__/parser.test.ts
import { describe, it, expect } from "vitest";
import { decodeScipRange, packRange, SymbolRole } from "../types";

describe("SCIP types", () => {
  it("decodes 3-element range (single line)", () => {
    const r = decodeScipRange([10, 5, 15]);
    expect(r).toEqual({ startLine: 10, startCol: 5, endLine: 10, endCol: 15 });
  });

  it("decodes 4-element range (multi line)", () => {
    const r = decodeScipRange([10, 5, 12, 3]);
    expect(r).toEqual({ startLine: 10, startCol: 5, endLine: 12, endCol: 3 });
  });

  it("packs range to integers", () => {
    const packed = packRange({ startLine: 10, startCol: 5, endLine: 10, endCol: 15 });
    expect(packed.start).toBe((10 << 16) | 5);
    expect(packed.end).toBe((10 << 16) | 15);
  });

  it("has correct role bitmask values", () => {
    expect(SymbolRole.Definition & 1).toBe(1);
    expect(SymbolRole.Import & 2).toBe(2);
  });
});
```

**Step 4: Implement SCIP parser**

```typescript
// packages/core/src/scip/parser.ts
import * as protobuf from "protobufjs";
import { join } from "path";
import { decodeScipRange, packRange, SymbolRole } from "./types";
import type { StoreQueries } from "../store/queries";

function extractSymbolName(scipSymbol: string): string {
  const parts = scipSymbol.split(/[./]/);
  const last = parts.filter((p) => p && !p.startsWith("`") && p !== "#" && p !== "()" && p !== "").pop();
  return last?.replace(/[`()#]/g, "") || scipSymbol;
}

function scipKindToString(kind?: number): string | undefined {
  const kinds: Record<number, string> = {
    2: "class", 3: "method", 4: "variable", 5: "function",
    6: "interface", 7: "module", 8: "type", 9: "enum", 10: "enum_member",
    11: "property", 12: "parameter",
  };
  return kind ? kinds[kind] : undefined;
}

export class ScipParser {
  private root: protobuf.Root | null = null;

  async loadProto(): Promise<void> {
    const protoPath = join(import.meta.dir, "scip.proto");
    this.root = await protobuf.load(protoPath);
  }

  async parse(scipFilePath: string): Promise<unknown> {
    if (!this.root) await this.loadProto();
    const IndexType = this.root!.lookupType("scip.Index");
    const buffer = await Bun.file(scipFilePath).arrayBuffer();
    const message = IndexType.decode(new Uint8Array(buffer));
    return IndexType.toObject(message, { longs: Number, enums: Number, defaults: true, arrays: true });
  }

  ingest(index: any, store: StoreQueries, repoRoot: string): {
    filesIngested: number;
    symbolsIngested: number;
    occurrencesIngested: number;
  } {
    let filesIngested = 0;
    let symbolsIngested = 0;
    let occurrencesIngested = 0;

    for (const doc of index.documents || []) {
      const filePath = doc.relativePath;
      const language = doc.language || "unknown";

      store.upsertFile({ path: filePath, language, hash: "" });
      store.clearOccurrencesForFile(filePath);
      filesIngested++;

      for (const sym of doc.symbols || []) {
        const name = sym.displayName || extractSymbolName(sym.symbol);
        store.upsertSymbol({
          id: sym.symbol,
          kind: scipKindToString(sym.kind),
          name,
          file_path: filePath,
          doc: sym.documentation?.join("\n"),
        });
        symbolsIngested++;
      }

      for (const occ of doc.occurrences || []) {
        if (!occ.symbol || occ.symbol.startsWith("local ")) continue;
        const range = decodeScipRange(occ.range);
        const packed = packRange(range);
        const roles = occ.symbolRoles || 0;

        store.upsertOccurrence({
          file_path: filePath,
          range_start: packed.start,
          range_end: packed.end,
          symbol_id: occ.symbol,
          roles,
        });
        occurrencesIngested++;

        if (roles & SymbolRole.Definition) {
          const existing = store.getSymbol(occ.symbol);
          const name = existing?.name || extractSymbolName(occ.symbol);
          store.upsertSymbol({
            id: occ.symbol, kind: existing?.kind, name,
            file_path: filePath, range_start: packed.start, range_end: packed.end, doc: existing?.doc,
          });
          store.insertEdge({ source: filePath, target: occ.symbol, kind: "defines", confidence: "high" });
        } else {
          store.insertEdge({ source: filePath, target: occ.symbol, kind: "references", confidence: "high" });
        }
      }
    }

    return { filesIngested, symbolsIngested, occurrencesIngested };
  }
}
```

**Step 5: Write integration test (runs scip-typescript on sample project)**

```typescript
// packages/core/src/scip/__tests__/parser-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ScipParser } from "../parser";
import { createDatabase } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { rmSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";

describe("ScipParser integration", () => {
  const testDir = "/tmp/ariadne-test-scip";
  const projectDir = `${testDir}/sample-project`;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("parses scip-typescript output from a sample project", async () => {
    writeFileSync(`${projectDir}/tsconfig.json`, JSON.stringify({
      compilerOptions: { target: "ESNext", module: "ESNext", strict: true },
      include: ["*.ts"],
    }));
    writeFileSync(`${projectDir}/math.ts`, `export function add(a: number, b: number): number { return a + b; }\n`);
    writeFileSync(`${projectDir}/main.ts`, `import { add } from "./math";\nconsole.log(add(1, 2));\n`);

    try {
      execSync("npx --yes @sourcegraph/scip-typescript index --infer-tsconfig", {
        cwd: projectDir, stdio: "pipe", timeout: 60000,
      });
    } catch {
      console.warn("scip-typescript not available, skipping integration test");
      return;
    }

    const parser = new ScipParser();
    const index = await parser.parse(`${projectDir}/index.scip`);
    expect((index as any).documents.length).toBeGreaterThan(0);

    const db = createDatabase(`${testDir}/index.db`);
    const store = new StoreQueries(db);
    const stats = parser.ingest(index, store, projectDir);
    expect(stats.filesIngested).toBeGreaterThan(0);
    expect(stats.occurrencesIngested).toBeGreaterThan(0);

    const symbols = store.searchSymbols("add", 10);
    expect(symbols.length).toBeGreaterThan(0);
    db.close();
  });
});
```

**Step 6: Run tests, commit**

Run: `bun test packages/core/src/scip/`
```bash
git add packages/core/src/scip/ && git commit -m "feat(core): add SCIP protobuf parser and ingestion"
```

---

## Task 6: SCIP Indexer Runners

**Files:**
- Create: `packages/core/src/indexers/types.ts`
- Create: `packages/core/src/indexers/scip-typescript.ts`
- Create: `packages/core/src/indexers/scip-python.ts`
- Test: `packages/core/src/indexers/__tests__/scip-typescript.test.ts`

**Step 1: Define indexer interface**

```typescript
// packages/core/src/indexers/types.ts
export interface IndexResult {
  scipFilePath: string;
  language: string;
  filesIndexed: number;
  errors: string[];
  duration: number;
}

export interface Indexer {
  name: string;
  canIndex(repoRoot: string): boolean;
  run(repoRoot: string, opts?: { targetDir?: string }): IndexResult;
}
```

**Step 2: Implement scip-typescript.ts and scip-python.ts**

TypeScript indexer runs `npx --yes @sourcegraph/scip-typescript index --infer-tsconfig`. Python indexer runs `uvx scip-python index`. Both check for project markers (`tsconfig.json` / `pyproject.toml`) in `canIndex()`.

**Step 3: Write canIndex detection tests**

```typescript
// packages/core/src/indexers/__tests__/scip-typescript.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ScipTypeScriptIndexer } from "../scip-typescript";
import { ScipPythonIndexer } from "../scip-python";
import { rmSync, mkdirSync, writeFileSync } from "fs";

describe("ScipTypeScriptIndexer", () => {
  const testDir = "/tmp/ariadne-test-indexer";
  beforeEach(() => { rmSync(testDir, { recursive: true, force: true }); mkdirSync(testDir, { recursive: true }); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("detects TypeScript projects", () => {
    const indexer = new ScipTypeScriptIndexer();
    expect(indexer.canIndex(testDir)).toBe(false);
    writeFileSync(`${testDir}/tsconfig.json`, "{}");
    expect(indexer.canIndex(testDir)).toBe(true);
  });
});

describe("ScipPythonIndexer", () => {
  const testDir = "/tmp/ariadne-test-indexer-py";
  beforeEach(() => { rmSync(testDir, { recursive: true, force: true }); mkdirSync(testDir, { recursive: true }); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("detects Python projects", () => {
    const indexer = new ScipPythonIndexer();
    expect(indexer.canIndex(testDir)).toBe(false);
    writeFileSync(`${testDir}/pyproject.toml`, "");
    expect(indexer.canIndex(testDir)).toBe(true);
  });
});
```

**Step 4: Run tests, commit**

Run: `bun test packages/core/src/indexers/`
```bash
git add packages/core/src/indexers/ && git commit -m "feat(core): add SCIP indexer runners for TS and Python"
```

---

## Task 7: Structural Import Extractor

**Files:**
- Create: `packages/core/src/indexers/import-extractor.ts`
- Test: `packages/core/src/indexers/__tests__/import-extractor.test.ts`

**Step 1: Write the failing test**

Tests extract ES imports, require() calls, re-exports from TS code, and `import`/`from` statements from Python code. Also tests `resolveModulePath()` for relative path resolution.

**Step 2: Implement using regex (no tree-sitter for MVP)**

Regex patterns: `TS_IMPORT_RE` for ES imports/exports, `TS_REQUIRE_RE` for CommonJS, `PY_IMPORT_RE` and `PY_FROM_IMPORT_RE` for Python. `resolveModulePath()` uses `path.join` + `path.normalize` for relative specifiers, returns bare specifiers as-is.

**Step 3: Run tests, commit**

```bash
git add packages/core/src/indexers/import-extractor.ts packages/core/src/indexers/__tests__/import-extractor.test.ts && git commit -m "feat(core): add structural import extractor"
```

---

## Task 8: Graph Queries — find_refs, get_def, search_symbol

**Files:**
- Create: `packages/core/src/graph/refs.ts`
- Test: `packages/core/src/graph/__tests__/refs.test.ts`

Seeds test data (symbols + occurrences), tests `searchSymbol()`, `getDef()`, `findRefs()` with and without `excludeDefinitions` option. Implementation reads from StoreQueries, unpacks ranges, optionally reads file snippets.

**Step 1-4:** Write test, implement, verify, commit.

```bash
git add packages/core/src/graph/ && git commit -m "feat(core): add graph queries — search, def, refs"
```

---

## Task 9: Graph Queries — impact analysis

**Files:**
- Create: `packages/core/src/graph/impact.ts`
- Test: `packages/core/src/graph/__tests__/impact.test.ts`

Seeds test data with files, symbols, occurrences, and import edges. Tests that `computeImpact(["src/math.ts"])` returns changed symbols, dependent files, and recommended test commands. Implementation: find defined symbols in changed files, find references to those symbols in other files, find importers via structural edges, identify test files among impacted set.

**Step 1-4:** Write test, implement, verify, commit.

```bash
git add packages/core/src/graph/ && git commit -m "feat(core): add impact analysis"
```

---

## Task 10: Module Dependency Graph

**Files:**
- Create: `packages/core/src/graph/modules.ts`
- Test: `packages/core/src/graph/__tests__/modules.test.ts`

Returns `{ nodes, edges }` from files + import/export edges. Supports optional `scopePath` filter.

**Step 1-4:** Write test, implement, verify, commit.

```bash
git add packages/core/src/graph/modules.ts packages/core/src/graph/__tests__/modules.test.ts && git commit -m "feat(core): add module dependency graph"
```

---

## Task 11: Verification Engine

**Files:**
- Create: `packages/core/src/verify/engine.ts`
- Create: `packages/core/src/verify/checks/index-freshness.ts`
- Create: `packages/core/src/verify/checks/missing-tests.ts`
- Create: `packages/core/src/verify/checks/unupdated-refs.ts`
- Test: `packages/core/src/verify/__tests__/engine.test.ts`

Three checks: index freshness (compare file hashes), missing test runs (ledger check), unupdated refs (MVP: placeholder pass). Returns structured `VerifyReport` with `status: "OK" | "FAIL"`.

**Step 1-4:** Write test, implement, verify, commit.

```bash
git add packages/core/src/verify/ && git commit -m "feat(core): add verification engine"
```

---

## Task 12: Core Public API

**Files:**
- Modify: `packages/core/src/index.ts`

Export all public types and classes from store, ledger, scip, graph, verify, and indexer modules.

```bash
git add packages/core/src/index.ts && git commit -m "feat(core): wire up public API exports"
```

---

## Task 13: CLI Commands

**Files:**
- Create: `packages/cli/src/index.ts` (command router)
- Create: `packages/cli/src/lib/context.ts` (shared CLI context)
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/src/commands/index-cmd.ts`
- Create: `packages/cli/src/commands/update.ts`
- Create: `packages/cli/src/commands/query.ts`
- Create: `packages/cli/src/commands/verify.ts`
- Create: `packages/cli/src/commands/ledger.ts`
- Create: `packages/cli/src/commands/status.ts`
- Test: `packages/cli/__tests__/e2e.test.ts`

CLI entry parses `process.argv`, routes to command modules. Each command gets context (db, store, ledger), calls core, prints JSON to stdout. `init` creates `.ariadne/`, generates hook config and MCP config. `verify` exits 1 on FAIL with `ARIADNE_VERIFY: FAIL` to stderr.

E2e test creates a temp project, runs init/update/ledger/verify commands via `execSync`.

```bash
git add packages/cli/ && git commit -m "feat(cli): add all CLI commands"
```

---

## Task 14: MCP Server

**Files:**
- Create: `packages/mcp/src/index.ts`

Uses `@modelcontextprotocol/sdk` with `McpServer` + `StdioServerTransport`. Registers 6 tools: `search_symbol`, `get_def`, `find_refs`, `impact`, `module_graph`, `status`. Each tool wraps core library calls and returns JSON text content. Uses `zod` for input schemas.

```bash
git add packages/mcp/ && git commit -m "feat(mcp): add MCP server with all 6 tools"
```

---

## Task 15: Hook Scripts + Integration

**Files:**
- Create: `packages/cli/src/hooks/post-edit.sh`
- Create: `packages/cli/src/hooks/post-test.sh`
- Create: `packages/cli/src/hooks/stop-verify.sh`

Shell scripts for Claude Code hooks. `post-edit.sh` runs update + logs edit. `post-test.sh` pattern-matches test runners + logs test_run. `stop-verify.sh` runs full update + verify.

```bash
chmod +x packages/cli/src/hooks/*.sh
git add packages/cli/src/hooks/ && git commit -m "feat(cli): add Claude Code hook scripts"
```

---

## Task 16: Final Wiring

**Step 1:** Update root `.gitignore`
**Step 2:** Run full test suite: `bun test`
**Step 3:** Final commit

```bash
git add -A && git commit -m "feat: complete MVP — ariadne CLI, MCP server, hooks, verification"
```

---

## Execution Order Summary

| Task | What | Depends On | Parallelizable With |
|------|------|-----------|-------------------|
| 1 | Monorepo scaffold | — | — |
| 2 | SQLite store schema | 1 | — |
| 3 | Store query layer | 2 | — |
| 4 | Ledger | 2 | 7 |
| 5 | SCIP protobuf parser | 3 | — |
| 6 | SCIP indexer runners | 5 | — |
| 7 | Import extractor | 3 | 4 |
| 8 | Graph queries (refs) | 3 | 11 |
| 9 | Impact analysis | 8, 7 | — |
| 10 | Module graph | 3, 7 | — |
| 11 | Verification engine | 3, 4 | 8 |
| 12 | Core public API | 3-11 | — |
| 13 | CLI commands | 12 | 14 |
| 14 | MCP server | 12 | 13 |
| 15 | Hook scripts + e2e | 13 | — |
| 16 | Final wiring | 13-15 | — |
