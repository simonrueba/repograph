#!/bin/bash
# PostToolUse hook: update index after file edits
# Receives JSON on stdin with tool_name, tool_input, etc.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Resolve repograph binary: PATH > node_modules/.bin > bun run fallback
resolve_bin() {
  if command -v repograph >/dev/null 2>&1; then
    echo "repograph"
  elif [ -x "node_modules/.bin/repograph" ]; then
    echo "node_modules/.bin/repograph"
  elif [ -f "packages/cli/src/index.ts" ]; then
    echo "bun run packages/cli/src/index.ts"
  else
    echo "repograph"
  fi
}
BIN="$(resolve_bin)"

# Read stdin and extract file_path using bun for reliable JSON parsing
STDIN_JSON="$(cat)"
FILE_PATH="$(echo "$STDIN_JSON" | bun -e 'const j=JSON.parse(await Bun.stdin.text());console.log(j?.tool_input?.file_path??"")' 2>/dev/null || true)"

# Guard: skip if .repograph/ doesn't exist (not initialized)
[ -d ".repograph" ] || exit 0

# Mark edited file dirty (tracks need for SCIP reindex)
# Guard: only mark source files — non-source files (README.md, package.json, etc.)
# can never be indexed by SCIP and cause false-positive freshness failures.
if [ -n "$FILE_PATH" ]; then
  case "$FILE_PATH" in
    *.ts|*.tsx|*.js|*.jsx|*.py) $BIN dirty mark "$FILE_PATH" 2>/dev/null || true ;;
  esac
fi

# Targeted update: only process the edited file (fast path).
# Falls back to full scan if no file path was extracted.
if [ -n "$FILE_PATH" ]; then
  REL_PATH="${FILE_PATH#$REPO_ROOT/}"
  $BIN update --files "$REL_PATH" 2>/dev/null || true
else
  $BIN update 2>/dev/null || true
fi
$BIN ledger log edit "{}" 2>/dev/null || true
