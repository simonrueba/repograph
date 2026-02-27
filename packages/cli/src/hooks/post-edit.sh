#!/bin/bash
# PostToolUse hook: update index after file edits
# Receives JSON on stdin with tool_name, tool_input, etc.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Guard: skip if .ariadne/ doesn't exist (not initialized)
[ -d ".ariadne" ] || exit 0

# Resolve ariadne binary: PATH > node_modules/.bin > bun run fallback
if [ -n "$ARIADNE_BIN" ]; then
  BIN="$ARIADNE_BIN"
elif command -v ariadne >/dev/null 2>&1; then
  BIN="ariadne"
elif [ -x "node_modules/.bin/ariadne" ]; then
  BIN="node_modules/.bin/ariadne"
elif [ -f "packages/cli/src/index.ts" ]; then
  BIN="bun run packages/cli/src/index.ts"
else
  BIN="ariadne"
fi

# Read stdin and extract file_path using native bash parameter expansion
STDIN_JSON="$(cat)"
tmp="${STDIN_JSON#*\"file_path\":\"}"
FILE_PATH="${tmp%%\"*}"
[[ "$FILE_PATH" == "$STDIN_JSON" ]] && FILE_PATH=""

[ -n "$FILE_PATH" ] || exit 0

REL_PATH="${FILE_PATH#$REPO_ROOT/}"

# Single combined command: dirty mark + targeted update + ledger log
$BIN post-edit "$REL_PATH" 2>/dev/null || true
