#!/bin/bash
# PostToolUse hook: update index after file edits
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"
bun run packages/cli/src/index.ts update 2>/dev/null || true
bun run packages/cli/src/index.ts ledger log edit "{\"tool\":\"${CLAUDE_TOOL_NAME:-unknown}\"}" 2>/dev/null || true
