#!/bin/bash
# PostToolUse hook: log test runs
# Receives JSON on stdin with tool_name, tool_input (including command), etc.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Resolve repograph binary: PATH > node_modules/.bin > bun run fallback
resolve_bin() {
  if command -v repograph >/dev/null 2>&1; then
    echo "repograph"
  elif [ -x "$REPO_ROOT/node_modules/.bin/repograph" ]; then
    echo "$REPO_ROOT/node_modules/.bin/repograph"
  elif [ -f "$REPO_ROOT/packages/cli/src/index.ts" ]; then
    echo "bun run $REPO_ROOT/packages/cli/src/index.ts"
  else
    echo "repograph"
  fi
}
BIN="$(resolve_bin)"

# Read hook input from stdin and extract command via bun for reliable JSON parsing
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | bun -e 'const j=JSON.parse(await Bun.stdin.text());console.log(j?.tool_input?.command??"")' 2>/dev/null || true)

# Only log if the command looks like a test runner
echo "$COMMAND" | grep -qiE '(vitest|jest|pytest|bun test|mocha|ava|cargo test|go test|npm test|npx vitest|npx jest|playwright)' && {
  cd "$REPO_ROOT"
  [ -d ".repograph" ] || exit 0
  $BIN ledger log test_run '{"command":"detected"}' 2>/dev/null || true
} || true
