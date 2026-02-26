# RepoGraph — Usage Guide

## Prerequisites

- Bun >= 1.0 (`curl -fsSL https://bun.sh/install | bash`)
- scip-typescript (`bun add -g @anthropic-ai/scip-typescript` or `npm i -g @anthropic-ai/scip-typescript`)
- Optional: scip-python for Python support

## Quick Start

### 1. Install dependencies

    bun install

### 2. Initialize

    bun run packages/cli/src/index.ts init .

Creates `.repograph/` with SQLite database, config files.

### 3. Full index

    bun run packages/cli/src/index.ts index .

Registers all source files, extracts imports, runs SCIP indexers.

### 4. Incremental update

    bun run packages/cli/src/index.ts update .
    bun run packages/cli/src/index.ts update --full .

`update` re-processes changed files (by content hash). `--full` also re-runs SCIP indexers for projects with dirty files.

### 5. Check health

    bun run packages/cli/src/index.ts doctor .

### 6. Query the graph

    # File dependency graph (imports / semantic / hybrid)
    bun run packages/cli/src/index.ts query module-graph --mode semantic --format mermaid --root .

    # Symbol graph centered on a symbol
    bun run packages/cli/src/index.ts query symbol-graph <symbol-id> --root .

    # Impact analysis
    bun run packages/cli/src/index.ts query impact <file-path> --root .

    # Search symbols
    bun run packages/cli/src/index.ts query search_symbol <name> --root .

    # Find references
    bun run packages/cli/src/index.ts query find_refs <symbol-id> --root .

### 7. Verify (gate check)

    bun run packages/cli/src/index.ts verify .

Runs: index freshness, test coverage tracking, TypeScript typecheck.
Writes `.repograph/verify_last.json` (redacted).
Exit code 1 on failure.

## Claude Code Integration

### Hooks Setup

Copy `.claude/settings.json.example` to `.claude/settings.json`:

    cp .claude/settings.json.example .claude/settings.json

This configures:
- **PostToolUse (Edit/Write)**: marks edited files dirty, runs incremental update, logs edit event
- **PostToolUse (Bash)**: detects test runner commands, logs test_run event
- **Stop**: runs verify gate — blocks task completion if checks fail

### MCP Server Setup

Copy `.mcp.json.example` to `.mcp.json`:

    cp .mcp.json.example .mcp.json

Gives Claude access to: `module_graph`, `symbol_graph`, `search_symbol`, `find_refs`, `impact`, `verify`, `status`, `file_symbols`.

### When Stop Blocks

If the Stop hook blocks, Claude will see:
> "RepoGraph verification failed. See .repograph/verify_last.json for details."

The report contains structured check results with recommendations. Common fixes:
- **INDEX_STALE**: Run `update --full` to re-index dirty files
- **MISSING_TEST_RUN**: Run tests (`bun test`)
- **TYPE_ERROR**: Fix TypeScript errors shown in the report

## Dirty Set Management

    # Mark a file as needing re-index
    bun run packages/cli/src/index.ts dirty mark <path>

    # List dirty files
    bun run packages/cli/src/index.ts dirty list

    # Clear all dirty flags
    bun run packages/cli/src/index.ts dirty clear

## Ledger

    # Log an event
    bun run packages/cli/src/index.ts ledger log <event> '<json>'

    # List events
    bun run packages/cli/src/index.ts ledger list

## Status

    bun run packages/cli/src/index.ts status .

Shows: file count, edge count, symbol count, dirty count, projects, timestamps.
