#!/bin/bash
# PostToolUse hook: update index after file edits
# Receives JSON on stdin with tool_name, tool_input, etc.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Guard: skip if .ariadne/ doesn't exist (not initialized)
[ -d ".ariadne" ] || exit 0

# Resolve ariadne binary: PATH > node_modules/.bin > bun run fallback
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

# Read stdin and extract file_path using native bash parameter expansion
STDIN_JSON="$(cat)"
tmp="${STDIN_JSON#*\"file_path\":\"}"
# If the pattern didn't match, tmp equals STDIN_JSON — no file_path present
[[ "$tmp" == "$STDIN_JSON" ]] && { exit 0; }
FILE_PATH="${tmp%%\"*}"

[ -n "$FILE_PATH" ] || exit 0

REL_PATH="${FILE_PATH#$REPO_ROOT/}"

# Single combined command: dirty mark + targeted update + ledger log
$BIN post-edit "$REL_PATH" 2>/dev/null || true

# ── Background SCIP reindex ──────────────────────────────────────────
# When enough dirty source files accumulate, spawn a background `update`
# to run SCIP indexing so symbols/refs stay fresh without waiting for
# the stop hook. Uses a lock dir to prevent concurrent runs.
# Threshold is configurable via ARIADNE_BG_THRESHOLD (default 5).
THRESHOLD="${ARIADNE_BG_THRESHOLD:-5}"
LOCK_DIR=".ariadne/.bg_index_lock"

# Fast dirty count (raw number, no JSON)
DIRTY_COUNT=$($BIN dirty count 2>/dev/null || echo "0")

if [ "$DIRTY_COUNT" -ge "$THRESHOLD" ] 2>/dev/null; then
  # Try to acquire lock — mkdir is atomic
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    # Spawn background update (detached, no stdin/stdout)
    (
      $BIN update >/dev/null 2>&1
      rm -rf "$LOCK_DIR"
    ) &
    disown
  else
    # Lock exists — check if stale (> 120s old, process likely crashed)
    if [ -f "$LOCK_DIR/pid" ]; then
      if stat -f %m "$LOCK_DIR/pid" >/dev/null 2>&1; then
        LOCK_MTIME=$(stat -f %m "$LOCK_DIR/pid")
      else
        LOCK_MTIME=$(stat -c %Y "$LOCK_DIR/pid" 2>/dev/null || echo "0")
      fi
      LOCK_AGE=$(( $(date +%s) - LOCK_MTIME ))
      if [ "$LOCK_AGE" -gt 120 ]; then
        rm -rf "$LOCK_DIR"
        # Re-acquire and spawn
        if mkdir "$LOCK_DIR" 2>/dev/null; then
          echo $$ > "$LOCK_DIR/pid"
          (
            $BIN update >/dev/null 2>&1
            rm -rf "$LOCK_DIR"
          ) &
          disown
        fi
      fi
    else
      # No pid file — lock dir is orphaned, remove it
      rm -rf "$LOCK_DIR"
    fi
  fi
fi
