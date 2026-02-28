# Multi-Language Support: Go + Rust

## Goal

Add Go and Rust support to Ariadne using a registry-based indexer pattern that makes future language additions trivial.

## Architecture

### Registry Pattern

Replace hardcoded if/else language dispatching with an indexer registry:

```typescript
const INDEXER_REGISTRY: Map<string, Indexer> = new Map([
  ["typescript", new ScipTypescriptIndexer()],
  ["python", new ScipPythonIndexer()],
  ["go", new ScipGoIndexer()],
  ["rust", new ScipRustIndexer()],
]);
```

Same pattern for typecheck verification — each language registers its checker.

### SCIP Indexer Tools

| Language | Tool | Detection Files | Install |
|----------|------|-----------------|---------|
| Go | `scip-go` | `go.mod` | `go install github.com/sourcegraph/scip-go@latest` |
| Rust | `rust-analyzer` | `Cargo.toml` | `rustup component add rust-analyzer` |

## Changes (11 touchpoints)

### New Files
1. `packages/core/src/indexers/scip-go.ts` — Go SCIP indexer
2. `packages/core/src/indexers/scip-rust.ts` — Rust SCIP indexer

### Modified Files
3. `packages/core/src/indexers/types.ts` — Extend Language type
4. `packages/core/src/indexers/project-detector.ts` — Add Go/Rust detection
5. `packages/core/src/indexers/import-extractor.ts` — Add Go/Rust import patterns
6. `packages/core/src/indexers/config-ref-scanner.ts` — Add Go/Rust env patterns
7. `packages/core/src/graph/impact.ts` — Add test patterns + commands
8. `packages/core/src/verify/checks/typecheck.ts` — Add Go vet + cargo check
9. `packages/core/src/index.ts` — Export new indexers
10. `packages/cli/src/commands/update.ts` — Registry-based indexer dispatch
11. `packages/cli/src/commands/index-cmd.ts` — Same extensions + languageFromExt
12. `packages/cli/src/commands/doctor.ts` — Add Go/Rust prerequisite checks
13. `packages/cli/src/hooks/pre-edit-impact.sh` — Add .go/.rs extensions
14. `packages/cli/src/hooks/post-edit.sh` — Already handled by post-edit command

## No Changes Needed
- SCIP parser (language-agnostic protobuf)
- Database schema (language is TEXT)
- Graph analysis (refs, impact, call-graph, module-graph)
- MCP server (operates on DB abstraction)
- Artifact extractor (handles config/data files)
