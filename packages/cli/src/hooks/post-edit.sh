#!/bin/bash
# PostToolUse hook: update index after file edits
# Receives JSON on stdin with tool_name, tool_input, etc.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Read stdin (hook input JSON) — we don't need to inspect it since
# the matcher already filters for Edit|Write|NotebookEdit
cat > /dev/null

bun run packages/cli/src/index.ts update 2>/dev/null || true
bun run packages/cli/src/index.ts ledger log edit "{}" 2>/dev/null || true
