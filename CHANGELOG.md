# Changelog

All notable changes to Ariadne are documented here.

## [Unreleased]

### Added
- Background SCIP reindex trigger in post-edit hook — spawns `ariadne update` when dirty file count exceeds threshold (configurable via `ARIADNE_BG_THRESHOLD`, default 5)
- Stale lock recovery (>120s) for background index lock
- `dirty count` subcommand for shell scripting
- GitHub Actions CI pipeline (typecheck, test, build)
- MIT license and security policy
- Contributing guide

### Fixed
- Bash JSON extraction guard in all hooks — correctly detects missing keys
- Stale dirty entries never cleared in multi-project repos (absolute paths from legacy hooks, root-level files outside any project prefix)
- `.mcp.json.example` still referenced old `repograph` name

### Changed
- `.mcp.json` removed from version control (use `.mcp.json.example` as template)
- `.gitignore` updated: `.ariadne/` replaces `.repograph/`

## [0.1.0-alpha.1] — 2026-02-25

Initial alpha release.

### Added
- Three-pass indexing pipeline: structural imports, SCIP symbols, non-code artifacts
- SQLite-backed symbol graph with WAL mode and concurrent access support
- CLI with 15+ commands: setup, init, index, update, query, verify, status, dirty, doctor, ledger
- MCP server with 9 read-only tools for AI agent integration
- Claude Code hooks: pre-edit impact analysis, post-edit auto-update, post-test detection, stop-gate verification
- Gatekeeper checks: empty index, freshness, missing tests, typecheck, architecture boundaries
- Multi-project monorepo support with auto-detection
- Module graph with three modes: imports, semantic, hybrid
- Impact analysis with detailed symbol defs and reference snippets
- Approximate call graph via enclosing-definition heuristic
- Non-code artifact indexing: .env vars, package.json, SQL migrations, OpenAPI schemas
- Architecture boundary enforcement via `ariadne.boundaries.json`
- Portable setup — works on any existing project

### Performance
- Batch DB operations and symbol caching during SCIP ingest
- Bulk transactions with index-drop/recreate for fast writes
- Content-hash-based skip logic to avoid redundant indexing
- Combined `post-edit` CLI command (single process instead of 3)
- SQLite performance pragmas (synchronous=NORMAL, 16MB cache, mmap, temp_store=MEMORY)
- Schema version check to skip re-execution on warm DB opens
- Batched symbol lookups, file queries, and edge queries to eliminate N+1 patterns
- Targeted single-file updates via `--files` flag (no full repo walk)
- Pure-bash JSON extraction in hooks (no subprocess spawning)

[Unreleased]: https://github.com/simonrueba/ariadne/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/simonrueba/ariadne/releases/tag/v0.1.0-alpha.1
