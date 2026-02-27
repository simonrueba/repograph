#!/bin/bash
# PostToolUse hook: log test runs
# Receives JSON on stdin with tool_name, tool_input (including command), etc.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Resolve ariadne binary: PATH > node_modules/.bin > bun run fallback
resolve_bin() {
  if command -v ariadne >/dev/null 2>&1; then
    echo "ariadne"
  elif [ -x "$REPO_ROOT/node_modules/.bin/ariadne" ]; then
    echo "$REPO_ROOT/node_modules/.bin/ariadne"
  elif [ -f "$REPO_ROOT/packages/cli/src/index.ts" ]; then
    echo "bun run $REPO_ROOT/packages/cli/src/index.ts"
  else
    echo "ariadne"
  fi
}
BIN="$(resolve_bin)"

# Read hook input from stdin and extract command using native bash (avoids ~200ms bun startup)
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | grep -o '"command":"[^"]*"' | head -1 | sed 's/"command":"\([^"]*\)"/\1/')

# Only log if the command looks like a test runner
echo "$COMMAND" | grep -qiE '(vitest|jest|pytest|bun test|mocha|ava|cargo test|go test|npm test|npx vitest|npx jest|playwright)' && {
  cd "$REPO_ROOT"
  [ -d ".ariadne" ] || exit 0
  $BIN ledger log test_run '{"command":"detected"}' 2>/dev/null || true
} || true
