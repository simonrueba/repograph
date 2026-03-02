#!/bin/bash
# PostToolUse hook for Bash: log test runs with pass/fail status.
# Receives JSON on stdin with tool_name, tool_input.command, and tool_response.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Resolve ariadne binary
if [ -n "$ARIADNE_BIN" ]; then
  BIN="$ARIADNE_BIN"
elif command -v ariadne >/dev/null 2>&1; then
  BIN="ariadne"
elif [ -x "$REPO_ROOT/node_modules/.bin/ariadne" ]; then
  BIN="$REPO_ROOT/node_modules/.bin/ariadne"
elif [ -f "$REPO_ROOT/packages/cli/src/index.ts" ]; then
  BIN="bun run $REPO_ROOT/packages/cli/src/index.ts"
else
  exit 0
fi

# Read hook input from stdin
INPUT=$(cat)

# Extract command using native bash
tmp="${INPUT#*\"command\":\"}"
[[ "$tmp" == "$INPUT" ]] && exit 0
COMMAND="${tmp%%\"*}"

# Only proceed if the command looks like a test runner
echo "$COMMAND" | grep -qiE '(vitest|jest|pytest|bun test|mocha|ava|cargo test|go test|npm test|npx vitest|npx jest|playwright)' || exit 0

cd "$REPO_ROOT"
[ -d ".ariadne" ] || exit 0

# Detect pass/fail from tool_response content
# PostToolUse provides tool_response which includes stdout/stderr
RESULT="unknown"
if echo "$INPUT" | grep -q '"tool_response"'; then
  RESPONSE_TMP="${INPUT#*\"tool_response\":}"
  # Check for common failure indicators
  if echo "$RESPONSE_TMP" | grep -qiE '(fail|error|FAILED|Error:|exit code [1-9])'; then
    RESULT="fail"
  elif echo "$RESPONSE_TMP" | grep -qiE '(pass|passed|success|0 fail| 0 errors)'; then
    RESULT="pass"
  fi
fi

$BIN ledger log test_run "{\"command\":\"detected\",\"result\":\"$RESULT\"}" 2>/dev/null || true
