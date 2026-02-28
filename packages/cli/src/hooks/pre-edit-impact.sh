#!/bin/bash
# PreToolUse hook: run impact analysis before Edit/Write to surface blast radius.
# Injects changedSymbols, dependentFiles, and recommendedTests as context
# so Claude sees what will be affected by the edit.
#
# Protocol: reads JSON on stdin, outputs hookSpecificOutput JSON on stdout.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Guard: skip if .ariadne/ doesn't exist (not initialized)
[ -d ".ariadne" ] || exit 0

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

# Read stdin once and extract file_path using native bash parameter expansion
STDIN_JSON="$(cat)"
tmp="${STDIN_JSON#*\"file_path\":\"}"
# If the pattern didn't match, tmp equals STDIN_JSON — no file_path present
[[ "$tmp" == "$STDIN_JSON" ]] && { exit 0; }
FILE_PATH="${tmp%%\"*}"

# Guard: need a file path to analyze
[ -n "$FILE_PATH" ] || exit 0

# Make path relative to repo root (impact expects relative paths)
REL_PATH="${FILE_PATH#$REPO_ROOT/}"

# Guard: skip non-source files (only analyze supported languages)
case "$REL_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.py|*.go|*.rs|*.java|*.kt|*.scala|*.cs|*.rb) ;;
  *) exit 0 ;;
esac

# Guard: skip test files — they are leaves, no blast radius
case "$REL_PATH" in
  *.test.*|*.spec.*|*__tests__/*|test_*|*_test.py|*_test.go|*_test.rs|*Test.java|*Test.kt|*Test.scala|*Spec.scala|*Tests.cs|*_test.rb|*_spec.rb) exit 0 ;;
esac

# Run impact analysis with --format=hook to get hookSpecificOutput directly
# (avoids a second ~200ms bun startup for JSON→text formatting)
$BIN query impact "$REL_PATH" --details --format=hook 2>/dev/null || true
