# RepoGraph

Semantic code index and gatekeeper for AI coding agents. Builds a compiler-grade symbol graph (defs/refs) via [SCIP](https://sourcegraph.com/docs/code-intelligence/scip) and a file-level dependency graph via import extraction. Exposes queries via CLI and MCP tools.

No LLMs involved — just static analysis.

## What it does

- **Indexes** your codebase into a SQLite graph of symbols, references, imports, and definitions
- **Queries** let you search symbols, jump to definitions, find all references, and trace impact of changes
- **Verifies** repo consistency: stale index detection, missing test runs, unupdated references
- **Integrates** with Claude Code via hooks (auto-update on edit, gatekeeper on stop) and MCP tools

## Quick start

```bash
# Install dependencies
bun install

# Initialize in your repo
bun run packages/cli/src/index.ts init

# Build the index (runs scip-typescript + structural import extraction)
bun run packages/cli/src/index.ts index

# Search for a symbol
bun run packages/cli/src/index.ts query search "MyFunction"

# Find definition
bun run packages/cli/src/index.ts query def "<symbol-id>"

# Find all references
bun run packages/cli/src/index.ts query refs "<symbol-id>"

# Impact analysis — what's affected by changes to a file?
bun run packages/cli/src/index.ts query impact src/foo.ts

# File dependency graph
bun run packages/cli/src/index.ts query module-graph

# Run gatekeeper checks
bun run packages/cli/src/index.ts verify
```

All commands output JSON. Symbol IDs are SCIP symbol strings returned by `search`.

## CLI commands

| Command | Description |
|---------|-------------|
| `init` | Create `.repograph/` directory and SQLite database |
| `index` | Full index: structural imports + SCIP analysis |
| `update [--full]` | Incremental update (structural only, or `--full` for SCIP re-index) |
| `query search <query>` | Fuzzy search symbols by name |
| `query def <symbol-id>` | Get definition location, docs, and code snippet |
| `query refs <symbol-id>` | Find all references across the codebase |
| `query impact <path>...` | Changed files → impacted symbols → dependent files → recommended tests |
| `query module-graph` | File-level import/export dependency graph |
| `verify` | Run gatekeeper checks (exit 0 = OK, exit 1 = FAIL) |
| `status` | Index stats (file count, symbol count, edge count) |
| `ledger log <event> <json>` | Append event to execution ledger |

## MCP server

Add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "repograph": {
      "command": "bun",
      "args": ["run", "packages/mcp/src/index.ts"],
      "env": { "REPOGRAPH_ROOT": "${PWD}" }
    }
  }
}
```

Exposes 6 tools: `search_symbol`, `get_def`, `find_refs`, `impact`, `module_graph`, `status`. All read-only.

## Claude Code hooks

Add to `.claude/settings.json` to auto-update the index on edits and gate completion on verification:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/packages/cli/src/hooks/post-edit.sh",
            "timeout": 120
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/packages/cli/src/hooks/post-test.sh",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/packages/cli/src/hooks/stop-verify.sh",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

- **Post-edit hook**: runs `repograph update` and logs the edit to the ledger
- **Post-test hook**: reads `tool_input.command` from stdin, logs `test_run` to the ledger if it matches a test runner
- **Stop hook**: runs structural `repograph update`, then a full SCIP re-index only if files are dirty, then `repograph verify`. On failure, outputs `{"decision":"block","reason":"..."}` to prevent Claude from stopping until issues are fixed. Checks `stop_hook_active` from stdin to prevent infinite loops.

## Gatekeeper checks

`repograph verify` runs three checks:

1. **Index freshness** — every source file on disk is hashed and compared to the stored hash. Fails if any file changed since last index.
2. **Missing test runs** — checks the ledger for a `test_run` event after the most recent `edit`. Fails if no tests were run after editing.
3. **Typecheck** — runs `tsc --noEmit` against the repo's `tsconfig.json`. Fails on any type errors. Skipped if no `tsconfig.json` exists.

## How indexing works

Two-pass pipeline:

1. **Structural pass** (instant, per-file) — regex-based extraction of `import`/`export`/`from` statements. Creates file-level `imports` edges. Runs on every `update`.
2. **SCIP pass** (slower, full project) — runs `scip-typescript` as a subprocess, producing a protobuf index. The parser decodes it and extracts symbols, occurrences (with line:col ranges), and definition/reference roles. Creates symbol-level `defines` and `references` edges. Runs on `index` and `update --full` only.

Both passes write to the same SQLite database (`.repograph/index.db`). This means the module graph updates immediately after edits, but symbol-level queries (search, refs, impact) may lag until the next full SCIP pass.

## Project structure

```
packages/
  core/     repograph-core library
    src/
      store/       SQLite schema + queries
      scip/        protobuf parser + SCIP types
      indexers/    scip-typescript, scip-python, import extractor
      graph/       refs, impact analysis, module graph
      verify/      gatekeeper engine + checks
      ledger/      execution event log
  cli/      CLI command router
  mcp/      MCP stdio server
```

## Development

```bash
bun install
bun test packages/core/     # 136 tests
bun tsc --build --noEmit    # type-check
```

Tests use `bun test` (not vitest) because the SQLite store uses `bun:sqlite`.

## Requirements

- [Bun](https://bun.sh) >= 1.0
- Node.js (for `scip-typescript` via npx)
- TypeScript project with `tsconfig.json` (for SCIP indexing)
