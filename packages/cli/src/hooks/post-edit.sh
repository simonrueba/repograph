#!/bin/bash
# PostToolUse hook: update index after file edits
# Receives JSON on stdin with tool_name, tool_input, etc.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Read stdin and extract file_path from tool_input
STDIN_JSON="$(cat)"
FILE_PATH="$(echo "$STDIN_JSON" | grep -o '"file_path":"[^"]*"' | head -1 | sed 's/"file_path":"//;s/"$//' || true)"

# Mark edited file dirty (tracks need for SCIP reindex)
if [ -n "$FILE_PATH" ]; then
  bun run packages/cli/src/index.ts dirty mark "$FILE_PATH" 2>/dev/null || true
fi

bun run packages/cli/src/index.ts update 2>/dev/null || true
bun run packages/cli/src/index.ts ledger log edit "{}" 2>/dev/null || true
