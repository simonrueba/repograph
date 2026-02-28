# Contributing to Ariadne

Thanks for your interest in contributing to Ariadne! This guide covers everything you need to get started.

## Development Setup

```bash
git clone https://github.com/simonrueba/ariadne.git
cd ariadne
bun install
```

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- `scip-typescript` — `bun add -g @anthropic-ai/scip-typescript` (optional, for SCIP indexing)
- `scip-python` — `pip install scip-python` (optional, for Python SCIP indexing)

### Running Tests

```bash
bun test                  # 371 tests across 23 files
bunx tsc --noEmit         # typecheck all packages
```

### Project Structure

```
packages/
  core/     Library: store, indexers, graph queries, verification
  cli/      CLI commands + Claude Code hook scripts
  mcp/      MCP stdio server (9 read-only tools)
```

## Making Changes

1. **Fork and clone** the repository
2. **Create a branch** from `main`: `git checkout -b feat/my-feature`
3. **Make your changes** — keep commits focused and atomic
4. **Run tests and typecheck**: `bun test && bunx tsc --noEmit`
5. **Open a PR** against `main`

### Commit Messages

We use [conventional commits](https://www.conventionalcommits.org/):

- `feat:` — new features
- `fix:` — bug fixes
- `perf:` — performance improvements
- `refactor:` — code changes that neither fix bugs nor add features
- `docs:` — documentation changes
- `chore:` — maintenance tasks
- `ci:` — CI/CD changes

### Code Style

- TypeScript strict mode — no `any` types
- Named exports over default exports
- Tests live next to source in `__tests__/` directories
- All CLI commands output JSON

### What Makes a Good PR

- Focused on a single concern
- Tests included for new functionality
- Existing tests still pass
- Type-safe (no `tsc` errors)
- Clear description of what changed and why

## Areas Where Help Is Welcome

- **Language support** — adding SCIP indexers for Go, Rust, Java, C#
- **Import extraction** — supporting more module systems (CommonJS `require`, Go imports, Rust `use`)
- **Verification checks** — new gatekeeper rules
- **Performance** — profiling and optimizing hot paths
- **Documentation** — examples, tutorials, integration guides

## Reporting Issues

- Use [GitHub Issues](https://github.com/simonrueba/ariadne/issues)
- Include reproduction steps, expected vs actual behavior
- For security issues, see [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
