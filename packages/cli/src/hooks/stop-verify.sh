#!/bin/bash
# Stop hook: full update + verify before allowing completion
# Outputs {"decision":"block","reason":"..."} to prevent stop on failure.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Read stdin (hook input JSON)
INPUT=$(cat)

GUARD_FILE=".repograph/.stop_guard"

# Guard file protection — prevent recursive Stop loops
if [ -f "$GUARD_FILE" ]; then
  GUARD_TS=$(cat "$GUARD_FILE" | grep -o '"ts":[0-9]*' | grep -o '[0-9]*' || echo "0")
  NOW=$(date +%s)
  AGE=$((NOW - GUARD_TS))
  if [ "$AGE" -lt 10 ]; then
    exit 0
  fi
fi

# Also check stop_hook_active from stdin as secondary guard
if echo "$INPUT" | grep -q '"stop_hook_active":true'; then
  exit 0
fi

# Create guard file
cleanup() { rm -f "$GUARD_FILE"; }
trap cleanup EXIT
echo "{\"pid\":$$,\"ts\":$(date +%s)}" > "$GUARD_FILE"

# Run update — only full SCIP re-index if there are dirty files
UPDATE_OUTPUT=$(bun run packages/cli/src/index.ts update 2>/dev/null) || true
STALE_COUNT=$(echo "$UPDATE_OUTPUT" | grep -o '"staleFiles":[0-9]*' | grep -o '[0-9]*' || echo "0")
if [ "$STALE_COUNT" -gt 0 ]; then
  bun run packages/cli/src/index.ts update --full 2>/dev/null || true
fi

VERIFY_OUTPUT=$(bun run packages/cli/src/index.ts verify 2>&1) || true

# Parse the verify report status — "status":"OK" means all checks passed
if echo "$VERIFY_OUTPUT" | grep -q '"status":"OK"'; then
  exit 0
fi

# Verification failed — block stop, reference the full report
echo "{\"decision\":\"block\",\"reason\":\"RepoGraph verification failed. See .repograph/verify_last.json for details.\"}"
exit 0
