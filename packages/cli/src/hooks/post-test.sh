#!/bin/bash
# PostToolUse hook: log test runs
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
echo "${CLAUDE_TOOL_ARG_command:-}" | grep -qE '(vitest|jest|pytest|bun test)' && {
  cd "$REPO_ROOT"
  bun run packages/cli/src/index.ts ledger log test_run "{\"command\":\"detected\"}" 2>/dev/null || true
} || true
