# Ariadne + Gatekeeper — Design Document

**Date:** 2026-02-25
**Status:** Approved

## Objective

Build a CLI tool + MCP server that continuously indexes a repo into a semantic dependency graph (defs/refs/imports/calls/tests) using non-LLM tooling, exposes queries to a coding agent, and blocks completion until repo-level verification passes.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Claude Code                        │
│                                                      │
│  PostToolUse hook ──→ ariadne update               │
│  Stop hook ──────────→ ariadne verify              │
│  MCP tools ──────────→ ariadne-mcp server          │
└─────────────────────────────────────────────────────┘
         │                    │                │
         ▼                    ▼                ▼
┌──────────────┐  ┌──────────────────┐  ┌───────────┐
│ ariadne CLI │  │ ariadne-mcp    │  │  Hooks    │
│              │  │ (stdio MCP)      │  │ (shell)   │
└──────┬───────┘  └────────┬─────────┘  └─────┬─────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────┐
│              ariadne-core (library)                 │
│                                                      │
│  ┌───────────┐ ┌──────────┐ ┌────────┐ ┌─────────┐ │
│  │ Indexers   │ │ SCIP     │ │ Import │ │ Verify  │ │
│  │ (scip-ts,  │ │ Parser   │ │ Extract│ │ Engine  │ │
│  │  scip-py)  │ │          │ │        │ │         │ │
│  └─────┬─────┘ └────┬─────┘ └───┬────┘ └────┬────┘ │
│        │             │           │            │      │
│        ▼             ▼           ▼            ▼      │
│  ┌─────────────────────────────────────────────────┐ │
│  │          SQLite (.ariadne/index.db)            │ │
│  │  files | symbols | occurrences | edges | ledger │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**Key decisions:**

- **Bun workspaces** monorepo: `core`, `cli`, `mcp`
- **CLI-first**: no daemon, no HTTP server. Hooks call CLI directly.
- **MCP server** is a thin stdio wrapper over the core library
- **SQLite** via `better-sqlite3` (synchronous, fast)
- **SCIP** as canonical semantic substrate via `scip-typescript` + `scip-python`
- **Tree-sitter** for structural import extraction
- **Soft gating**: Stop hook runs `ariadne verify`, prints structured failure report

## Data Model (SQLite)

```sql
-- Files tracked in the index
files (
  path        TEXT PRIMARY KEY,
  language    TEXT NOT NULL,       -- 'typescript' | 'python' | 'unknown'
  hash        TEXT NOT NULL,       -- content hash for dirty detection
  indexed_at  INTEGER NOT NULL     -- unix timestamp
)

-- Symbols extracted from SCIP
symbols (
  id          TEXT PRIMARY KEY,   -- SCIP symbol string (globally unique)
  kind        TEXT,               -- 'function' | 'class' | 'variable' | 'module' | 'interface' | 'type' | 'method'
  name        TEXT NOT NULL,      -- human-readable short name
  file_path   TEXT,               -- where defined (NULL if external)
  range_start INTEGER,            -- line:col packed as (line << 16 | col)
  range_end   INTEGER,
  doc         TEXT                 -- docstring if available
)

-- Every mention of a symbol in the codebase
occurrences (
  file_path   TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end   INTEGER NOT NULL,
  symbol_id   TEXT NOT NULL,
  roles       INTEGER NOT NULL,   -- bitmask: 1=definition, 2=reference, 4=import, 8=export
  PRIMARY KEY (file_path, range_start, symbol_id)
)

-- Derived + structural edges
edges (
  source      TEXT NOT NULL,      -- file path or symbol ID
  target      TEXT NOT NULL,      -- file path or symbol ID
  kind        TEXT NOT NULL,      -- 'defines' | 'references' | 'imports' | 'exports' | 'calls'
  confidence  TEXT DEFAULT 'high' -- 'high' (SCIP) | 'medium' (tree-sitter) | 'low' (heuristic)
)

-- Execution ledger (tracks agent actions)
ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   INTEGER NOT NULL,
  event       TEXT NOT NULL,      -- 'edit' | 'test_run' | 'verify' | 'index_update'
  data        TEXT NOT NULL       -- JSON payload
)
```

Indexes on: `occurrences(symbol_id)`, `edges(source)`, `edges(target)`, `edges(kind)`.

## Indexing Pipeline

### SCIP Indexers (subprocess runners)

```typescript
interface IndexResult {
  scipFilePath: string
  language: string
  filesIndexed: number
  errors: string[]
}

interface Indexer {
  name: string
  canIndex(repoRoot: string): boolean
  run(repoRoot: string, opts?: { targetDir?: string }): IndexResult
}
```

**TypeScript:** `npx @sourcegraph/scip-typescript index --infer-tsconfig`
**Python:** `scip-python index . --project-name=<name>` (via uvx or pip)

### SCIP Parser

1. Read `index.scip` protobuf via `@sourcegraph/scip` TS bindings
2. Walk `Index.documents[]` → extract occurrences, symbols
3. Derive `defines` and `references` edges from occurrence roles
4. Upsert into SQLite

### Structural Import Extractor (tree-sitter)

- `tree-sitter-typescript` and `tree-sitter-python`
- Extract import/export statements
- Resolve module specifiers to file paths (approximate Node/Python resolution)
- Insert `imports`/`exports` edges with `confidence: 'medium'`

### Incremental Update Strategy

`ariadne update [--full]`:

1. Walk repo, hash every tracked file
2. Compare against `files.hash` in SQLite
3. Dirty files → re-run structural import extraction (instant, per-file)
4. Dirty files → mark their SCIP project "stale"
5. If `--full` or >N files changed: re-run SCIP indexer for stale projects
6. Re-ingest SCIP output
7. Rebuild affected edges

After a single edit: structural layer updates immediately, SCIP refreshes on next `--full` or `verify`.

## CLI Commands

```
ariadne init                          # Create .ariadne/, init SQLite, install hooks
ariadne index [--full]                # Full SCIP + structural index
ariadne update [--full]               # Incremental update
ariadne query def <symbol-query>      # Find definition
ariadne query refs <symbol-id>        # Find all references
ariadne query search <query> [--k=N]  # Fuzzy search symbols
ariadne query impact <path>...        # Changed files → impacted symbols/files/tests
ariadne query module-graph [<path>]   # File/module dependency graph
ariadne verify                        # Gatekeeper checks (exit 0=OK, exit 1=FAIL)
ariadne ledger log <event> <json>     # Append to execution ledger
ariadne status                        # Index stats
```

All commands output JSON to stdout. `--pretty` for human-readable.

## MCP Tools

```
ariadne.search_symbol(query, k?)
  → [{ id, name, kind, filePath, range }]

ariadne.get_def(symbolId)
  → { id, name, kind, filePath, range, doc, snippet }

ariadne.find_refs(symbolId, scope?)
  → [{ filePath, range, roles, snippet }]

ariadne.impact(paths: string[])
  → {
      changedSymbols: [{ id, name, filePath }],
      dependentFiles: [{ path, reason }],
      recommendedTests: [{ command, reason }],
      unresolvedRefs: [{ symbolId, filePath, range }]
    }

ariadne.module_graph(path?)
  → { nodes: [{ path, language }], edges: [{ from, to, kind }] }

ariadne.status()
  → { totalFiles, totalSymbols, staleFiles, lastIndexed }
```

All tools are `readOnlyHint: true`. Return IDs + paths + ranges + short snippets (max 3 lines), never whole files.

### Test Recommendation Heuristic

1. Find test files: `**/*.test.ts`, `**/*.spec.ts`, `**/test_*.py`, `**/*_test.py`
2. Extract their imports (structural layer)
3. If test imports any impacted module → recommend it
4. Format as: `vitest run <path>` / `pytest <path>`

## Gatekeeper Verification

`ariadne verify` runs checks, exit 0=OK, exit 1=FAIL.

### Check 1: Unupdated References

- Compute diff since last verified state (`.ariadne/verified-ref`)
- Extract changed symbols whose definition range overlaps changed lines
- If signature changed: find all references via SCIP
- FAIL if any reference site not also modified

### Check 2: Missing Test Runs

- Check ledger for `test_run` events after most recent `edit` event
- Use `impact()` to determine recommended test set
- FAIL if no tests executed after last edit

### Check 3: Index Staleness

- Compare file hashes on disk vs in index
- FAIL if any stale files

### Output Format

```json
{
  "status": "FAIL",
  "timestamp": 1709312500,
  "checks": {
    "unupdatedRefs": { "passed": false, "issues": [...] },
    "testCoverage": { "passed": false, "issues": [...] },
    "indexFreshness": { "passed": true, "issues": [] }
  },
  "summary": "2 checks failed. Fix UNUPDATED_REFERENCES and MISSING_TEST_RUN."
}
```

On pass: store git HEAD as `.ariadne/verified-ref`, append `verify: PASS` to ledger, print `ARIADNE_VERIFY: OK`.

## Claude Code Integration

### PostToolUse — After File Edits

Trigger on `Edit|Write|NotebookEdit`:
- `ariadne update` (structural refresh)
- Log edit to ledger

### PostToolUse — After Test Runs

Trigger on `Bash`, pattern-match for test runners (`vitest|jest|pytest|bun test`):
- Log `test_run` to ledger

### Stop Hook — Gatekeeper Gate

- `ariadne update --full` (full SCIP refresh)
- `ariadne verify`
- If FAIL: structured report → agent sees it, must address issues
- If OK: `ARIADNE_VERIFY: OK`, agent stops cleanly

### MCP Registration

```json
{
  "mcpServers": {
    "ariadne": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "--filter", "ariadne-mcp", "start"],
      "env": { "ARIADNE_ROOT": "${PWD}" }
    }
  }
}
```

`ariadne init` creates hooks config + MCP registration automatically.

## Package Structure

```
ariadne/
├── package.json                    # Bun workspace root
├── bunfig.toml
├── tsconfig.json
├── packages/
│   ├── core/                       # ariadne-core library
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── store/              # db.ts, schema.ts, queries.ts
│   │   │   ├── indexers/           # types.ts, scip-typescript.ts, scip-python.ts, import-extractor.ts
│   │   │   ├── scip/              # parser.ts
│   │   │   ├── graph/             # refs.ts, impact.ts, modules.ts
│   │   │   ├── verify/            # engine.ts, unupdated-refs.ts, missing-tests.ts, index-freshness.ts
│   │   │   └── ledger/            # ledger.ts
│   │   └── __tests__/
│   ├── cli/                        # ariadne CLI
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── commands/           # init.ts, index-cmd.ts, update.ts, query.ts, verify.ts, ledger.ts, status.ts
│   │   └── __tests__/
│   └── mcp/                        # ariadne-mcp server
│       ├── src/
│       │   ├── index.ts
│       │   └── tools/              # search-symbol.ts, get-def.ts, find-refs.ts, impact.ts, module-graph.ts, status.ts
│       └── __tests__/
├── docs/plans/
└── .ariadne/                     # Created by ariadne init (gitignored)
```

### Key Dependencies

- `better-sqlite3` — SQLite driver
- `@sourcegraph/scip` — SCIP protobuf bindings
- `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python` — structural parsing
- `@modelcontextprotocol/sdk` — MCP SDK
- `vitest` — test runner
