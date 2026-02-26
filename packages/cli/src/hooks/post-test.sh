#!/bin/bash
# PostToolUse hook: log test runs
# Receives JSON on stdin with tool_name, tool_input (including command), etc.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Read hook input from stdin
INPUT=$(cat)

# Extract the command from tool_input.command
COMMAND=$(echo "$INPUT" | grep -o '"command":"[^"]*"' | head -1 | sed 's/"command":"//;s/"//')

# Only log if the command looks like a test runner
echo "$COMMAND" | grep -qE '(vitest|jest|pytest|bun test)' && {
  cd "$REPO_ROOT"
  bun run packages/cli/src/index.ts ledger log test_run "{\"command\":\"detected\"}" 2>/dev/null || true
} || true
