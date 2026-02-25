#!/bin/bash
# Stop hook: full update + verify before allowing completion
# Outputs {"decision":"block","reason":"..."} to prevent stop on failure.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Read stdin (hook input JSON)
INPUT=$(cat)

# Prevent infinite loops — if stop hook is already active, allow stop
if echo "$INPUT" | grep -q '"stop_hook_active":true'; then
  exit 0
fi

# Run update — only full SCIP re-index if there are dirty files
UPDATE_OUTPUT=$(bun run packages/cli/src/index.ts update 2>/dev/null) || true
STALE_COUNT=$(echo "$UPDATE_OUTPUT" | grep -o '"staleFiles":[0-9]*' | grep -o '[0-9]*' || echo "0")
if [ "$STALE_COUNT" -gt 0 ]; then
  bun run packages/cli/src/index.ts update --full 2>/dev/null || true
fi

VERIFY_OUTPUT=$(bun run packages/cli/src/index.ts verify 2>&1) || true
VERIFY_STATUS=$(echo "$VERIFY_OUTPUT" | grep -c 'REPOGRAPH_VERIFY: OK' || true)

if [ "$VERIFY_STATUS" -eq 0 ]; then
  # Verification failed — block stop
  SUMMARY=$(echo "$VERIFY_OUTPUT" | head -1)
  echo "{\"decision\":\"block\",\"reason\":\"RepoGraph verification failed: $SUMMARY\"}"
  exit 0
fi

# Verification passed — allow stop
exit 0
