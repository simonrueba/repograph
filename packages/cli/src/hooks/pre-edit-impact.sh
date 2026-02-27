#!/bin/bash
# PreToolUse hook: run impact analysis before Edit/Write to surface blast radius.
# Injects changedSymbols, dependentFiles, and recommendedTests as context
# so Claude sees what will be affected by the edit.
#
# Protocol: reads JSON on stdin, outputs hookSpecificOutput JSON on stdout.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Guard: skip if .repograph/ doesn't exist (not initialized)
[ -d ".repograph" ] || exit 0

# Resolve repograph binary
resolve_bin() {
  if command -v repograph >/dev/null 2>&1; then
    echo "repograph"
  elif [ -x "node_modules/.bin/repograph" ]; then
    echo "node_modules/.bin/repograph"
  elif [ -f "packages/cli/src/index.ts" ]; then
    echo "bun run packages/cli/src/index.ts"
  else
    echo "repograph"
  fi
}
BIN="$(resolve_bin)"

# Read stdin once
STDIN_JSON="$(cat)"

# Extract file_path from tool_input using bun
FILE_PATH="$(echo "$STDIN_JSON" | bun -e '
  const j = JSON.parse(await Bun.stdin.text());
  console.log(j?.tool_input?.file_path ?? "");
' 2>/dev/null || true)"

# Guard: need a file path to analyze
[ -n "$FILE_PATH" ] || exit 0

# Make path relative to repo root (impact expects relative paths)
REL_PATH="${FILE_PATH#$REPO_ROOT/}"

# Guard: skip non-source files (only analyze .ts, .tsx, .js, .jsx, .py)
case "$REL_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.py) ;;
  *) exit 0 ;;
esac

# Guard: skip test files — they are leaves, no blast radius
case "$REL_PATH" in
  *.test.*|*.spec.*|*__tests__/*|test_*|*_test.py) exit 0 ;;
esac

# Run impact analysis (--json for machine-readable output)
IMPACT_JSON="$($BIN query impact "$REL_PATH" --details --json 2>/dev/null || true)"

# Guard: if impact failed or returned empty, silently allow
[ -n "$IMPACT_JSON" ] || exit 0

# Parse impact, format context, and emit hook response in one bun invocation
echo "$IMPACT_JSON" | bun -e '
const raw = await Bun.stdin.text();
try {
  const data = JSON.parse(raw);
  const r = data.data ? data.data.result : (data.result || data);

  const symbols = r.changedSymbols || [];
  const deps = r.dependentFiles || [];
  const tests = r.recommendedTests || [];

  if (symbols.length === 0 && deps.length === 0 && tests.length === 0) {
    process.exit(0);
  }

  const file = process.argv[1] || "file";
  const lines = [];
  lines.push("[Impact Analysis] Editing " + file);

  if (symbols.length > 0) {
    const names = [...new Set(symbols.map(s => s.name))];
    lines.push("  Symbols defined here: " + names.slice(0, 20).join(", ") + (names.length > 20 ? " (+" + (names.length - 20) + " more)" : ""));
  }

  if (deps.length > 0) {
    const top = deps.slice(0, 10);
    lines.push("  Dependent files (" + deps.length + "): " + top.map(d => d.path).join(", ") + (deps.length > 10 ? " (+" + (deps.length - 10) + " more)" : ""));
  }

  if (tests.length > 0) {
    lines.push("  Recommended tests: " + tests.map(t => t.command).join(", "));
  }

  const symbolDetails = r.symbolDetails || [];
  if (symbolDetails.length > 0) {
    const detailLines = symbolDetails.slice(0, 5).map(s => {
      const kind = s.kind ? ` (${s.kind})` : "";
      const doc = s.doc ? " — " + s.doc.split("\n").slice(0, 2).join(" ") : "";
      return `    ${s.name}${kind}${doc}`;
    });
    lines.push("  Symbol details:");
    lines.push(...detailLines);
  }

  const keyRefs = r.keyRefs || [];
  if (keyRefs.length > 0) {
    const refLines = keyRefs.slice(0, 5).map(kr =>
      `    ${kr.symbolName} in ${kr.filePath}` + (kr.snippet ? `: ${kr.snippet.split("\n")[0]}` : "")
    );
    lines.push("  Key references:");
    lines.push(...refLines);
  }

  const context = lines.join("\n");
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context
    }
  };
  console.log(JSON.stringify(output));
} catch (e) {
  process.exit(0);
}
' "$REL_PATH" 2>/dev/null
