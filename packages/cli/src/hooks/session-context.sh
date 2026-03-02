#!/bin/bash
# SessionStart hook: inject Ariadne project state as context for the agent.
# Fires on startup, resume, and after context compaction so the agent
# always knows the current index health and any pending issues.
#
# Outputs plain text on stdout — Claude receives it as additionalContext.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Guard: skip if .ariadne/ doesn't exist (not initialized)
[ -d ".ariadne" ] || exit 0

# Resolve ariadne binary
if [ -n "$ARIADNE_BIN" ]; then
  BIN="$ARIADNE_BIN"
elif command -v ariadne >/dev/null 2>&1; then
  BIN="ariadne"
elif [ -x "node_modules/.bin/ariadne" ]; then
  BIN="node_modules/.bin/ariadne"
elif [ -f "packages/cli/src/index.ts" ]; then
  BIN="bun run packages/cli/src/index.ts"
else
  exit 0
fi

# Collect status
STATUS_JSON=$($BIN status 2>/dev/null) || exit 0

# Extract key fields using native bash (avoid jq dependency)
# File count — field is "totalFiles" in the JSON envelope
tmp="${STATUS_JSON#*\"totalFiles\":}"
FILE_COUNT="${tmp%%[,\}]*}"

# Symbol count — field is "totalSymbols"
tmp="${STATUS_JSON#*\"totalSymbols\":}"
SYMBOL_COUNT="${tmp%%[,\}]*}"

# Dirty count
DIRTY_COUNT=$($BIN dirty count 2>/dev/null || echo "0")

# Last verify status (from cached report — may be pretty-printed)
VERIFY_STATUS="unknown"
if [ -f ".ariadne/verify_last.json" ]; then
  # Read as single line, strip spaces around colons to normalize
  VERIFY_CONTENT=$(tr -d '\n ' < .ariadne/verify_last.json)
  v="${VERIFY_CONTENT#*\"status\":\"}"
  VERIFY_STATUS="${v%%\"*}"
fi

# Build context string
CONTEXT="[Ariadne] Index: ${FILE_COUNT} files, ${SYMBOL_COUNT} symbols"

if [ "$DIRTY_COUNT" -gt 0 ] 2>/dev/null; then
  CONTEXT="$CONTEXT | ${DIRTY_COUNT} dirty files (run \`ariadne update\` before analysis)"
fi

if [ "$VERIFY_STATUS" != "OK" ] && [ "$VERIFY_STATUS" != "unknown" ]; then
  CONTEXT="$CONTEXT | Last verify: ${VERIFY_STATUS} (check .ariadne/verify_last.json)"
fi

# Check index freshness — warn if older than 1 hour
if [ -f ".ariadne/index.db" ]; then
  if stat -f %m ".ariadne/index.db" >/dev/null 2>&1; then
    DB_MTIME=$(stat -f %m ".ariadne/index.db")
  else
    DB_MTIME=$(stat -c %Y ".ariadne/index.db" 2>/dev/null || echo "0")
  fi
  NOW=$(date +%s)
  AGE=$(( NOW - DB_MTIME ))
  if [ "$AGE" -gt 3600 ]; then
    HOURS=$(( AGE / 3600 ))
    CONTEXT="$CONTEXT | Index is ${HOURS}h old — consider re-indexing"
  fi
fi

# Available tools reminder (especially after compaction when context is lost)
CONTEXT="$CONTEXT | Tools: ariadne scope (context for tasks), ariadne preflight (pre-edit analysis), ariadne ci --base main (PR risk report)"

echo "$CONTEXT"
