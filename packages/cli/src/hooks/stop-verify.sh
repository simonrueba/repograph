#!/bin/bash
# Stop hook: full update + verify before allowing completion
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"
bun run packages/cli/src/index.ts update --full 2>/dev/null
bun run packages/cli/src/index.ts verify
