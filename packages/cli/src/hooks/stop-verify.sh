#!/bin/bash
# Stop hook: full update + verify before allowing completion
# Outputs {"decision":"block","reason":"..."} to prevent stop on failure.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Read stdin (hook input JSON)
INPUT=$(cat)

# Check stop_hook_active from stdin — prevent infinite loops
if echo "$INPUT" | grep -q '"stop_hook_active":true'; then
  exit 0
fi

# Atomic lock via mkdir (fails if directory already exists = another hook is running)
LOCK_DIR=".repograph/.stop_lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Lock exists — check if it's stale (> 120s old)
  if [ -f "$LOCK_DIR/pid" ]; then
    LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR/pid" 2>/dev/null || echo "0") ))
    if [ "$LOCK_AGE" -gt 120 ]; then
      rm -rf "$LOCK_DIR"
      mkdir "$LOCK_DIR" 2>/dev/null || exit 0
    else
      exit 0
    fi
  else
    exit 0
  fi
fi

# Write PID for stale lock detection
echo $$ > "$LOCK_DIR/pid"

# Cleanup lock on exit
cleanup() { rm -rf "$LOCK_DIR"; }
trap cleanup EXIT

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
