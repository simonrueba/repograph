import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative, extname } from "path";
import {
  extractImports,
  resolveModulePath,
  ScipTypescriptIndexer,
  ScipPythonIndexer,
  ScipParser,
  detectProjects,
} from "repograph-core";
import { getContext } from "../lib/context";
import { output } from "../lib/output";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".repograph", ".git"]);

function languageFromExt(ext: string): string {
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  if ([".js", ".jsx"].includes(ext)) return "javascript";
  if (ext === ".py") return "python";
  return "unknown";
}

function hashContent(content: Buffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

function walkSourceFiles(
  dir: string,
  repoRoot: string,
): { path: string; fullPath: string; ext: string }[] {
  const results: { path: string; fullPath: string; ext: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir) as string[];
  } catch {
    return results;
  }

  for (const name of entries) {
    const fullPath = join(dir, name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith(".")) {
        results.push(...walkSourceFiles(fullPath, repoRoot));
      }
    } else if (stat.isFile()) {
      const ext = extname(name);
      if (SOURCE_EXTENSIONS.has(ext)) {
        results.push({ path: relative(repoRoot, fullPath), fullPath, ext });
      }
    }
  }
  return results;
}

export async function runIndex(args: string[]): Promise<void> {
  const structuralOnly = args.includes("--structural-only");
  const rootArg = args.find((a) => !a.startsWith("--"));
  const ctx = getContext(rootArg);
  const sourceFiles = walkSourceFiles(ctx.repoRoot, ctx.repoRoot);

  // Register all files and extract structural imports
  const fileHashes = new Map<string, string>();
  for (const file of sourceFiles) {
    const content = readFileSync(file.fullPath);
    const hash = hashContent(content);
    fileHashes.set(file.path, hash);
    const language = languageFromExt(file.ext);

    ctx.store.upsertFile({ path: file.path, language, hash });

    // Extract structural imports
    const code = content.toString("utf-8");
    const imports = extractImports(code, language);
    ctx.store.clearEdgesForFile(file.path);
    for (const imp of imports) {
      const target = resolveModulePath(imp.specifier, file.path, language);
      ctx.store.insertEdge({
        source: file.path,
        target,
        kind: "imports",
        confidence: "structural",
      });
    }
  }

  // Record structural index timestamp
  ctx.store.setMeta("last_structural_index_ts", String(Date.now()));

  // Skip SCIP indexing if --structural-only
  if (structuralOnly) {
    ctx.store.clearAllDirty();
    ctx.ledger.log("index", { fileCount: sourceFiles.length, indexers: [], structuralOnly: true });
    ctx.db.close();
    output("index", { fileCount: sourceFiles.length, indexers: [] });
    return;
  }

  // Detect projects for per-project SCIP indexing
  const projects = detectProjects(ctx.repoRoot);

  // Register each detected project in the store
  for (const p of projects) {
    ctx.store.upsertProject({
      project_id: p.projectId,
      root: p.projectId, // store relative path for DB consistency
      language: p.language,
      last_index_ts: 0,
    });
  }

  // Run SCIP indexers per project
  const indexerResults: { indexer: string; result: unknown }[] = [];
  const tsIndexer = new ScipTypescriptIndexer();
  const pyIndexer = new ScipPythonIndexer();

  // Helper: run a SCIP indexer, parse, and ingest — with proper error surfacing
  async function runScipIndexer(
    indexer: { name: string; run: typeof tsIndexer.run },
    projectId?: string,
    targetDir?: string,
  ): Promise<void> {
    const result = indexer.run(ctx.repoRoot, targetDir ? { targetDir, projectId } : undefined);

    // If SCIP produced no file, surface the errors instead of silently failing
    if (!result.scipFilePath || !existsSync(result.scipFilePath)) {
      indexerResults.push({
        indexer: indexer.name,
        result: { errors: result.errors, projectId, warning: "no SCIP index produced" },
      });
      return;
    }

    const parser = new ScipParser();
    const index = await parser.parse(result.scipFilePath);
    // Reuse pre-built file hash map for skip-unchanged; index is always a full run → bulk mode
    const ingested = parser.ingest(index, ctx.store, ctx.repoRoot, projectId, {
      fileHashes,
      bulk: true,
    });
    indexerResults.push({
      indexer: indexer.name,
      result: { ...result, ...ingested, projectId },
    });
    if (projectId) {
      ctx.store.setProjectIndexTs(projectId, Date.now());
    }
  }

  const warnings: string[] = [];

  if (projects.length > 0) {
    // Multi-project path: iterate detected projects
    for (const project of projects) {
      const targetDir = project.root; // already absolute from detectProjects

      if (project.language === "typescript" && tsIndexer.canIndex(targetDir)) {
        try {
          await runScipIndexer(tsIndexer, project.projectId, targetDir);
        } catch (err: any) {
          indexerResults.push({
            indexer: "scip-typescript",
            result: { error: err.message, projectId: project.projectId },
          });
        }
      }

      if (project.language === "python" && pyIndexer.canIndex(targetDir)) {
        try {
          await runScipIndexer(pyIndexer, project.projectId, targetDir);
        } catch (err: any) {
          indexerResults.push({
            indexer: "scip-python",
            result: { error: err.message, projectId: project.projectId },
          });
        }
      }
    }
  } else {
    // Fallback: single-project behavior at repo root
    if (tsIndexer.canIndex(ctx.repoRoot)) {
      try {
        await runScipIndexer(tsIndexer);
      } catch (err: any) {
        indexerResults.push({
          indexer: "scip-typescript",
          result: { error: err.message },
        });
      }
    }

    if (pyIndexer.canIndex(ctx.repoRoot)) {
      try {
        await runScipIndexer(pyIndexer);
      } catch (err: any) {
        indexerResults.push({
          indexer: "scip-python",
          result: { error: err.message },
        });
      }
    }

    if (!tsIndexer.canIndex(ctx.repoRoot) && !pyIndexer.canIndex(ctx.repoRoot)) {
      warnings.push(
        "no SCIP-compatible project detected (need tsconfig.json, pyproject.toml, or setup.py) " +
        "— only structural imports indexed, symbol search will be empty",
      );
    }
  }

  // Record SCIP timestamp and clear dirty (full index covers everything)
  const anyScipSuccess = indexerResults.some((r) => {
    const res = r.result as any;
    return !res.error && !res.warning;
  });
  if (anyScipSuccess) {
    ctx.store.setMeta("last_full_scip_index_ts", String(Date.now()));
  }
  ctx.store.clearAllDirty();

  // Check if symbols were actually ingested — warn if not
  const symbolCount = ctx.store.searchSymbols("").length;
  if (sourceFiles.length > 0 && symbolCount === 0 && !structuralOnly) {
    warnings.push(
      `indexed ${sourceFiles.length} files but 0 symbols — SCIP indexing likely failed. ` +
      `Run 'repograph doctor' to check prerequisites.`,
    );
  }

  ctx.ledger.log("index", {
    fileCount: sourceFiles.length,
    indexers: indexerResults.map((r) => r.indexer),
  });

  ctx.db.close();

  const result: Record<string, unknown> = {
    fileCount: sourceFiles.length,
    indexers: indexerResults,
  };
  if (warnings.length > 0) {
    result.warnings = warnings;
  }
  output("index", result);
}
