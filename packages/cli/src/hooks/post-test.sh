#!/bin/bash
# PostToolUse hook: log test runs
# Receives JSON on stdin with tool_name, tool_input (including command), etc.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Resolve ariadne binary (cached via env var)
if [ -n "$ARIADNE_BIN" ]; then
  BIN="$ARIADNE_BIN"
elif command -v ariadne >/dev/null 2>&1; then
  BIN="ariadne"
elif [ -x "$REPO_ROOT/node_modules/.bin/ariadne" ]; then
  BIN="$REPO_ROOT/node_modules/.bin/ariadne"
elif [ -f "$REPO_ROOT/packages/cli/src/index.ts" ]; then
  BIN="bun run $REPO_ROOT/packages/cli/src/index.ts"
else
  BIN="ariadne"
fi

# Read hook input from stdin and extract command using native bash parameter expansion
INPUT=$(cat)
tmp="${INPUT#*\"command\":\"}"
COMMAND="${tmp%%\"*}"
[[ "$COMMAND" == "$INPUT" ]] && COMMAND=""

# Only log if the command looks like a test runner
echo "$COMMAND" | grep -qiE '(vitest|jest|pytest|bun test|mocha|ava|cargo test|go test|npm test|npx vitest|npx jest|playwright)' && {
  cd "$REPO_ROOT"
  [ -d ".ariadne" ] || exit 0
  $BIN ledger log test_run '{"command":"detected"}' 2>/dev/null || true
} || true
