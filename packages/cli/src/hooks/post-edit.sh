#!/bin/bash
# PostToolUse hook: update index after file edits
# Receives JSON on stdin with tool_name, tool_input, etc.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Read stdin and extract file_path using bun for reliable JSON parsing
STDIN_JSON="$(cat)"
FILE_PATH="$(echo "$STDIN_JSON" | bun -e 'const j=JSON.parse(await Bun.stdin.text());console.log(j?.tool_input?.file_path??"")' 2>/dev/null || true)"

# Mark edited file dirty (tracks need for SCIP reindex)
if [ -n "$FILE_PATH" ]; then
  bun run packages/cli/src/index.ts dirty mark "$FILE_PATH" 2>/dev/null || true
fi

bun run packages/cli/src/index.ts update 2>/dev/null || true
bun run packages/cli/src/index.ts ledger log edit "{}" 2>/dev/null || true
