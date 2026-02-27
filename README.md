# RepoGraph

Semantic code index and gatekeeper for AI coding agents. Builds a compiler-grade symbol graph (defs/refs) via [SCIP](https://sourcegraph.com/docs/code-intelligence/scip) and a file-level dependency graph via import extraction. Exposes queries via CLI and MCP tools.

No LLMs involved — just static analysis.

## What it does

- **Indexes** your codebase into a SQLite graph of symbols, references, imports, and definitions
- **Queries** let you search symbols, jump to definitions, find all references, and trace impact of changes
- **Verifies** repo consistency: stale index detection, empty index detection, missing test runs, type errors
- **Integrates** with Claude Code via hooks (auto-update on edit, gatekeeper on stop) and MCP tools
- **Works on any existing project** — run `setup` and it indexes everything from disk

## Quick start

### Use on any project (recommended)

```bash
# Clone repograph
git clone <repo-url> repograph && cd repograph
bun install

# Set up on your project — does everything in one step:
# init → index → generate hooks + MCP config
bun run packages/cli/src/index.ts setup /path/to/your/project
```

This creates:
- `.repograph/` — SQLite database, hook scripts, SCIP cache
- `.claude/settings.json` — Claude Code hooks (impact context on edit, auto-update, verify gate)
- `.mcp.json` — MCP server config (8 read-only tools)

Then restart Claude Code in your project to pick up the hooks and MCP server.

### Manual setup (step by step)

```bash
# Initialize .repograph/ directory
bun run packages/cli/src/index.ts init /path/to/your/project

# Build the full index (structural imports + SCIP symbols)
bun run packages/cli/src/index.ts index /path/to/your/project

# Check prerequisites
bun run packages/cli/src/index.ts doctor /path/to/your/project

# Run gatekeeper checks
bun run packages/cli/src/index.ts verify /path/to/your/project
```

### Query examples

```bash
# Search for a symbol
bun run packages/cli/src/index.ts query search "MyFunction"

# Find definition
bun run packages/cli/src/index.ts query def "<symbol-id>"

# Find all references
bun run packages/cli/src/index.ts query refs "<symbol-id>"

# Impact analysis — what's affected by changes to a file?
bun run packages/cli/src/index.ts query impact src/foo.ts

# File dependency graph (imports only)
bun run packages/cli/src/index.ts query module-graph

# Hybrid module graph (imports + SCIP semantic edges with weights)
bun run packages/cli/src/index.ts query module-graph --mode hybrid

# Scoped to a directory
bun run packages/cli/src/index.ts query module-graph --path packages/core/
```

All commands output JSON. Symbol IDs are SCIP symbol strings returned by `search`.

## CLI commands

| Command | Description |
|---------|-------------|
| `setup [path] [--quick]` | One-command setup: init + index + generate hooks & MCP config. `--quick` skips SCIP. |
| `init [path]` | Create `.repograph/` directory and SQLite database |
| `index [path] [--structural-only]` | Full index: structural imports + SCIP analysis. `--structural-only` skips SCIP. |
| `update [--full]` | Incremental update: structural imports + auto SCIP when dirty source files exist. `--full` forces SCIP even when clean. |
| `query search <query>` | Fuzzy search symbols by name |
| `query def <symbol-id>` | Get definition location, docs, and code snippet |
| `query refs <symbol-id>` | Find all references across the codebase |
| `query impact <path>...` | Changed files → impacted symbols → dependent files → recommended tests |
| `query module-graph [--mode] [--path] [--format]` | File dependency graph (imports, semantic, or hybrid) |
| `verify` | Run gatekeeper checks (exit 0 = OK, exit 1 = FAIL) |
| `status` | Index stats (file count, symbol count, edge count, dirty count) |
| `dirty mark <path>` | Mark a file as needing re-index |
| `ledger log <event> <json>` | Append event to execution ledger |
| `doctor [path]` | Check prerequisites (Bun, Node, scip-typescript, scip-python) |

## MCP server

The MCP server exposes 8 read-only tools for AI agents:

| Tool | Description |
|------|-------------|
| `repograph.search_symbol` | Fuzzy search symbols by name |
| `repograph.get_def` | Get symbol definition with docs and code snippet |
| `repograph.find_refs` | Find all references to a symbol (optionally scoped) |
| `repograph.impact` | Blast radius analysis for changed files |
| `repograph.module_graph` | File dependency graph (imports/semantic/hybrid, json/dot/mermaid) |
| `repograph.symbol_graph` | Dependency subgraph centered on a specific symbol |
| `repograph.file_symbols` | List all symbols defined in a file |
| `repograph.status` | Index stats: files, symbols, dirty count, timestamps |

### Configuration

`repograph setup` generates this automatically. To configure manually, add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "repograph": {
      "command": "bun",
      "args": ["run", "/path/to/repograph/packages/mcp/src/index.ts"],
      "env": { "REPOGRAPH_ROOT": "." }
    }
  }
}
```

The MCP server starts gracefully even if `.repograph/` doesn't exist yet — it creates the directory and logs a helpful message.

## Claude Code hooks

`repograph setup` generates `.claude/settings.json` automatically. The hooks reference portable scripts in `.repograph/hooks/` that resolve the `repograph` binary dynamically at runtime.

### What the hooks do

- **Pre-edit impact hook** (`Edit|Write` PreToolUse): runs `repograph impact` before every source file edit and injects the blast radius (changed symbols, dependent files, recommended tests) as context so Claude sees what will be affected. Silently skips test files, non-source files, and uninitialized projects. ~240ms latency.
- **Post-edit hook** (`Edit|Write` PostToolUse): marks edited source files (`.ts/.tsx/.js/.jsx/.py`) dirty, runs `repograph update`, logs the edit to the ledger. Non-source files (README, config, etc.) are skipped to avoid false-positive freshness failures.
- **Post-test hook** (`Bash` PostToolUse): detects test runner commands (vitest, jest, pytest, bun test, mocha, ava, cargo test, go test, playwright), logs `test_run` to the ledger
- **Stop hook**: runs `repograph update` (auto-triggers SCIP when dirty source files exist), then `repograph verify`. On failure, outputs `{"decision":"block","reason":"..."}` to prevent Claude from stopping until issues are fixed

The stop hook uses atomic `mkdir`-based locking to prevent concurrent runs, checks `stop_hook_active` from stdin to prevent infinite loops, and has a 120s stale lock timeout.

All hooks guard against missing `.repograph/` — they silently exit if the project hasn't been initialized.

## Gatekeeper checks

`repograph verify` runs these checks:

1. **Empty index** — fails if zero files are indexed (prevents vacuous pass on uninitialized projects)
2. **Index freshness** — checks the dirty set (files marked changed by hooks or `update`), filtering to source files only. Fails if any dirty source files exist that haven't been covered by a SCIP index pass. Non-source files are ignored since SCIP can't index them.
3. **Missing test runs** — checks the ledger for a `test_run` event after the most recent `edit`. Fails if no tests were run after editing.
4. **Typecheck** — runs `tsc --noEmit` against the repo's `tsconfig.json`. Fails on any type errors. On failure, includes recommendations with `repograph query impact` commands for the top error files. Skipped if no `tsconfig.json` exists.

## How indexing works

Two-pass pipeline:

1. **Structural pass** (instant, per-file) — regex-based extraction of `import`/`export`/`from` statements, including side-effect imports (`import "module"`), dynamic imports (`import("module")`), and Python relative imports (`from . import`). Creates file-level `imports` edges. Runs on every `update`.
2. **SCIP pass** (slower, full project) — runs `scip-typescript` or `scip-python` per detected sub-project, producing a protobuf index. The parser decodes it and extracts symbols, occurrences (with line:col ranges), and definition/reference roles. Creates symbol-level `defines` and `references` edges. Runs on `index`, `update` (when dirty source files exist), and `update --full` (forced).

Both passes write to the same SQLite database (`.repograph/index.db`). The database uses WAL mode, `busy_timeout=5000` for concurrent access from hooks, and transactions for atomic SCIP ingestion. Bulk ingestion uses index-drop/recreate and `PRAGMA synchronous=OFF` for faster writes, and skips unchanged files by content hash comparison.

### Multi-project support

RepoGraph auto-detects sub-projects in monorepos by scanning for `tsconfig.json` and Python project files. Each sub-project is indexed independently with correct path prefixing so that SCIP-relative paths map correctly to repo-root-relative file paths.

### Module graph modes

The `module-graph` query supports three modes:

- **imports** (default) — structural import edges only
- **semantic** — SCIP-derived edges with occurrence weights (how many times symbols from file A are referenced in file B)
- **hybrid** — union of both, with source tagging (`import`, `semantic`, or `import+semantic`)

Output formats: `json` (default), `dot` (Graphviz), `mermaid`.

## Project structure

```
packages/
  core/     repograph-core library (300+ tests)
    src/
      store/       SQLite schema, queries, transactions
      scip/        protobuf parser + SCIP types
      indexers/    scip-typescript, scip-python, import extractor, project detector
      graph/       refs, impact analysis, module graph (import/semantic/hybrid)
      verify/      gatekeeper engine + checks (freshness, tests, typecheck)
      ledger/      execution event log
  cli/      CLI command router + hooks
    src/
      commands/    init, setup, index, update, query, verify, status, dirty, doctor, ledger
      hooks/       pre-edit-impact.sh, post-edit.sh, post-test.sh, stop-verify.sh
      lib/         context, output helpers
  mcp/      MCP stdio server (8 read-only tools)
```

## Development

```bash
bun install
bun test                  # 300+ tests across 15 files
bunx tsc --noEmit         # type-check all packages
bun run packages/cli/src/index.ts doctor  # check prerequisites
```

## Requirements

- [Bun](https://bun.sh) >= 1.0
- `scip-typescript` (for TypeScript SCIP indexing — optional, structural imports still work without it)
- `scip-python` (for Python SCIP indexing — optional)

## Supported languages

- TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`) — full SCIP + structural import support
- Python (`.py`) — full SCIP + structural import support

## License

MIT
