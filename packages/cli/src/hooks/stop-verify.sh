#!/bin/bash
# Stop hook: full update + verify before allowing completion
# Outputs {"decision":"block","reason":"..."} to prevent stop on failure.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Guard: skip if .ariadne/ doesn't exist (not initialized)
[ -d ".ariadne" ] || exit 0

# Read stdin (hook input JSON)
INPUT=$(cat)

# Check stop_hook_active from stdin using native bash — prevent infinite loops
tmp="${INPUT#*\"stop_hook_active\":}"
stop_val="${tmp%%[,\}]*}"
[[ "$stop_val" == "true" ]] && exit 0

# Resolve ariadne binary (cached via env var)
if [ -n "$ARIADNE_BIN" ]; then
  BIN="$ARIADNE_BIN"
elif command -v ariadne >/dev/null 2>&1; then
  BIN="ariadne"
elif [ -x "node_modules/.bin/ariadne" ]; then
  BIN="node_modules/.bin/ariadne"
elif [ -f "packages/cli/src/index.ts" ]; then
  BIN="bun run packages/cli/src/index.ts"
else
  BIN="ariadne"
fi

# Atomic lock via mkdir (fails if directory already exists = another hook is running)
LOCK_DIR=".ariadne/.stop_lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Lock exists — check if it's stale (> 120s old)
  if [ -f "$LOCK_DIR/pid" ]; then
    # Cross-platform stat: BSD/macOS uses -f %m, GNU/Linux uses -c %Y
    if stat -f %m "$LOCK_DIR/pid" >/dev/null 2>&1; then
      LOCK_MTIME=$(stat -f %m "$LOCK_DIR/pid")
    else
      LOCK_MTIME=$(stat -c %Y "$LOCK_DIR/pid" 2>/dev/null || echo "0")
    fi
    LOCK_AGE=$(( $(date +%s) - LOCK_MTIME ))
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

# Run update — auto-triggers SCIP when dirty source files exist
$BIN update 2>/dev/null || true

VERIFY_OUTPUT=$($BIN verify 2>&1) || true

# Parse the verify report status — "status":"OK" means all checks passed
if echo "$VERIFY_OUTPUT" | grep -q '"status":"OK"'; then
  exit 0
fi

# Verification failed — block stop, reference the full report
echo "{\"decision\":\"block\",\"reason\":\"Ariadne verification failed. See .ariadne/verify_last.json for details.\"}"
exit 0
