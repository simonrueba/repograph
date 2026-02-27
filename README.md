# Ariadne

Semantic code index and gatekeeper for AI coding agents. Builds a compiler-grade symbol graph (defs/refs) via [SCIP](https://sourcegraph.com/docs/code-intelligence/scip) and a file-level dependency graph via import extraction. Exposes queries via CLI and MCP tools.

No LLMs involved — just static analysis.

## What it does

- **Indexes** your codebase into a SQLite graph of symbols, references, imports, and definitions
- **Queries** let you search symbols, jump to definitions, find all references, trace impact of changes, and explore call graphs
- **Verifies** repo consistency: stale index detection, empty index detection, missing test runs, type errors, and architecture boundary violations
- **Indexes non-code artifacts** — `.env` vars, `package.json` scripts, SQL migrations, OpenAPI schemas — and links them to source references
- **Integrates** with Claude Code via hooks (auto-update on edit, gatekeeper on stop) and MCP tools
- **Works on any existing project** — run `setup` and it indexes everything from disk

## Quick start

### Use on any project (recommended)

```bash
# Clone ariadne
git clone <repo-url> ariadne && cd ariadne
bun install

# Set up on your project — does everything in one step:
# init → index → generate hooks + MCP config
bun run packages/cli/src/index.ts setup /path/to/your/project
```

This creates:
- `.ariadne/` — SQLite database, hook scripts, SCIP cache
- `.claude/settings.json` — Claude Code hooks (impact context on edit, auto-update, verify gate)
- `.mcp.json` — MCP server config (9 read-only tools)
- `ariadne.boundaries.json` — auto-generated architecture boundary config (monorepos)

Then restart Claude Code in your project to pick up the hooks and MCP server.

### Manual setup (step by step)

```bash
# Initialize .ariadne/ directory
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

# Detailed impact — includes symbol defs, docs, and reference snippets
bun run packages/cli/src/index.ts query impact src/foo.ts --details

# Call graph — who calls a function, and what does it call?
bun run packages/cli/src/index.ts query call-graph "<symbol-id>"
bun run packages/cli/src/index.ts query call-graph "<symbol-id>" --depth 2

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
| `init [path]` | Create `.ariadne/` directory and SQLite database |
| `index [path] [--structural-only]` | Full index: structural imports + SCIP analysis. `--structural-only` skips SCIP. |
| `update [--full] [--files path...]` | Incremental update: structural imports + auto SCIP when dirty source files exist. `--files` processes only the specified files (used by hooks for fast single-file updates). `--full` forces SCIP even when clean. |
| `query search <query>` | Fuzzy search symbols by name |
| `query def <symbol-id>` | Get definition location, docs, and code snippet |
| `query refs <symbol-id>` | Find all references across the codebase |
| `query impact <path>... [--details]` | Changed files → impacted symbols → dependent files → recommended tests. `--details` adds symbol defs, docs, and up to 3 reference snippets per symbol. |
| `query call-graph <symbol-id> [--depth N]` | Approximate call graph: callers and callees at the given depth (default 1) |
| `query module-graph [--mode] [--path] [--format]` | File dependency graph (imports, semantic, or hybrid) |
| `verify` | Run gatekeeper checks (exit 0 = OK, exit 1 = FAIL) |
| `status` | Index stats (file count, symbol count, edge count, dirty count) |
| `dirty mark <path>` | Mark a file as needing re-index |
| `ledger log <event> <json>` | Append event to execution ledger |
| `doctor [path]` | Check prerequisites (Bun, Node, scip-typescript, scip-python) |

## MCP server

The MCP server exposes 9 read-only tools for AI agents:

| Tool | Description |
|------|-------------|
| `ariadne.search_symbol` | Fuzzy search symbols by name |
| `ariadne.get_def` | Get symbol definition with docs and code snippet |
| `ariadne.find_refs` | Find all references to a symbol (optionally scoped) |
| `ariadne.impact` | Blast radius analysis for changed files (with optional `details` for symbol defs and key refs) |
| `ariadne.module_graph` | File dependency graph (imports/semantic/hybrid, json/dot/mermaid) |
| `ariadne.symbol_graph` | Dependency subgraph centered on a specific symbol |
| `ariadne.file_symbols` | List all symbols defined in a file |
| `ariadne.status` | Index stats: files, symbols, dirty count, timestamps |
| `ariadne.call_graph` | Approximate call graph: callers and callees for a symbol |

### Configuration

`ariadne setup` generates this automatically. To configure manually, add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "ariadne": {
      "command": "bun",
      "args": ["run", "/path/to/ariadne/packages/mcp/src/index.ts"],
      "env": { "ARIADNE_ROOT": "." }
    }
  }
}
```

The MCP server starts gracefully even if `.ariadne/` doesn't exist yet — it creates the directory and logs a helpful message.

## Claude Code hooks

`ariadne setup` generates `.claude/settings.json` automatically. The hooks reference portable scripts in `.ariadne/hooks/` that resolve the `ariadne` binary dynamically at runtime.

### What the hooks do

- **Pre-edit impact hook** (`Edit|Write` PreToolUse): runs `ariadne impact` before every source file edit and injects the blast radius (changed symbols, dependent files, recommended tests) as context so Claude sees what will be affected. Silently skips test files, non-source files, and uninitialized projects. ~240ms latency.
- **Post-edit hook** (`Edit|Write` PostToolUse): marks edited source files (`.ts/.tsx/.js/.jsx/.py`) dirty, runs `ariadne update --files <path>` for fast single-file updates (no full repo walk), logs the edit to the ledger. Non-source files (README, config, etc.) are skipped to avoid false-positive freshness failures.
- **Post-test hook** (`Bash` PostToolUse): detects test runner commands (vitest, jest, pytest, bun test, mocha, ava, cargo test, go test, playwright), logs `test_run` to the ledger
- **Stop hook**: runs `ariadne update` (auto-triggers SCIP when dirty source files exist), then `ariadne verify`. On failure, outputs `{"decision":"block","reason":"..."}` to prevent Claude from stopping until issues are fixed

The stop hook uses atomic `mkdir`-based locking to prevent concurrent runs, checks `stop_hook_active` from stdin to prevent infinite loops, and has a 120s stale lock timeout.

All hooks guard against missing `.ariadne/` — they silently exit if the project hasn't been initialized.

## Gatekeeper checks

`ariadne verify` runs these checks:

1. **Empty index** — fails if zero files are indexed (prevents vacuous pass on uninitialized projects)
2. **Index freshness** — checks the dirty set (files marked changed by hooks or `update`), filtering to source files only. Fails if any dirty source files exist that haven't been covered by a SCIP index pass. Non-source files are ignored since SCIP can't index them.
3. **Missing test runs** — checks the ledger for a `test_run` event after the most recent `edit`. Fails if no tests were run after editing.
4. **Typecheck** — runs `tsc --noEmit` against the repo's `tsconfig.json`. Fails on any type errors. On failure, includes recommendations with `ariadne query impact` and `ariadne query search` commands for the affected files and identifiers. Skipped if no `tsconfig.json` exists.
5. **Architecture boundaries** — reads `ariadne.boundaries.json` and checks all `imports` edges against layer allowlists. Fails if any file imports from a layer not in its `canImport` list. Skipped if no config file exists.

## How indexing works

Three-pass pipeline:

1. **Structural pass** (instant, per-file) — regex-based extraction of `import`/`export`/`from` statements, including side-effect imports (`import "module"`), dynamic imports (`import("module")`), and Python relative imports (`from . import`). Creates file-level `imports` edges with resolved file paths (e.g. `./utils` → `src/utils.ts`) so edges point to actual file nodes. Runs on every `update`.
2. **SCIP pass** (slower, full project) — runs `scip-typescript` or `scip-python` per detected sub-project, producing a protobuf index. The parser decodes it and extracts symbols, occurrences (with line:col ranges), and definition/reference roles. Creates symbol-level `defines`, `references`, and approximate `calls` edges (via enclosing-definition heuristic). Runs on `index`, `update` (when dirty source files exist), and `update --full` (forced).
3. **Artifact pass** (instant, per-file) — extracts pseudo-symbols from non-code files: `.env` vars (`env_var`), `package.json`/`tsconfig.json` keys (`config_key`), SQL migrations (`table`, `index`), and OpenAPI specs (`api_endpoint`, `api_schema`). Scans dirty source files for references (`process.env.KEY`, `os.environ`, SQL table names) and creates `config_ref` edges. Runs on every `update`.

All passes write to the same SQLite database (`.ariadne/index.db`). The database uses WAL mode, `busy_timeout=5000` for concurrent access from hooks, and transactions for atomic SCIP ingestion. Bulk ingestion uses index-drop/recreate and `PRAGMA synchronous=OFF` for faster writes, and skips unchanged files by content hash comparison.

### Multi-project support

Ariadne auto-detects sub-projects in monorepos by scanning for `tsconfig.json` and Python project files. Each sub-project is indexed independently with correct path prefixing so that SCIP-relative paths map correctly to repo-root-relative file paths.

### Module graph modes

The `module-graph` query supports three modes:

- **imports** (default) — structural import edges only
- **semantic** — SCIP-derived edges with occurrence weights (how many times symbols from file A are referenced in file B)
- **hybrid** — union of both, with source tagging (`import`, `semantic`, or `import+semantic`)

Output formats: `json` (default), `dot` (Graphviz), `mermaid`.

## Project structure

```
packages/
  core/     ariadne-core library (360+ tests)
    src/
      store/       SQLite schema, queries, transactions
      scip/        protobuf parser + SCIP types + call graph derivation
      indexers/    scip-typescript, scip-python, import extractor, project detector, artifact extractor, config ref scanner
      graph/       refs, impact analysis, call graph, module graph (import/semantic/hybrid), shared utils
      verify/      gatekeeper engine + checks (freshness, tests, typecheck, boundaries)
      ledger/      execution event log
  cli/      CLI command router + hooks
    src/
      commands/    init, setup, index, update, query, verify, status, dirty, doctor, ledger
      hooks/       pre-edit-impact.sh, post-edit.sh, post-test.sh, stop-verify.sh
      lib/         context, output helpers
  mcp/      MCP stdio server (9 read-only tools)
```

## Development

```bash
bun install
bun test                  # 360+ tests across 23 files
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
