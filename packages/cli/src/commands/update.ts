import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative, extname } from "path";
import {
  extractImports,
  resolveModulePath,
  ScipTypescriptIndexer,
  ScipPythonIndexer,
  ScipParser,
  detectProjects,
  extractArtifacts,
  scanConfigRefs,
  type ArtifactSymbol,
} from "ariadne-core";
import { getContext } from "../lib/context";
import { output } from "../lib/output";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".ariadne", ".git"]);
const ARTIFACT_GLOBS = new Set([".env", "package.json", "tsconfig.json"]);
const ARTIFACT_EXTENSIONS = new Set([".sql", ".yaml", ".yml"]);

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

interface WalkedFile {
  path: string;
  fullPath: string;
  ext: string;
  hash: string;
  /** Cached UTF-8 content from hash read — avoids re-reading for import extraction. */
  content?: string;
}

function walkSourceFiles(dir: string, repoRoot: string): WalkedFile[] {
  const results: WalkedFile[] = [];
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
        const raw = readFileSync(fullPath);
        const hash = hashContent(raw);
        // Cache content as UTF-8 string to avoid re-reading for import extraction
        results.push({ path: relative(repoRoot, fullPath), fullPath, ext, hash, content: raw.toString("utf-8") });
      }
    }
  }
  return results;
}

/**
 * Determine whether a file path belongs to a project root.
 * Both `filePath` and `projectRoot` are relative to `repoRoot`.
 */
function fileInProject(filePath: string, projectRoot: string): boolean {
  if (projectRoot === "." || projectRoot === "") {
    // Root-level project encompasses everything
    return true;
  }
  const normalized = projectRoot.endsWith("/") ? projectRoot : projectRoot + "/";
  return filePath.startsWith(normalized);
}

/**
 * Parse --files flag: collects all args after --files until the next flag or end.
 * Returns the file paths, or null if --files was not provided.
 */
function parseFilesFlag(args: string[]): string[] | null {
  const idx = args.indexOf("--files");
  if (idx === -1) return null;
  const files: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    files.push(args[i]);
  }
  return files.length > 0 ? files : null;
}

/**
 * Targeted update: process only the specified files instead of walking the
 * entire repo tree. Used by the post-edit hook for fast single-file updates.
 */
function processTargetedFiles(filePaths: string[], repoRoot: string): WalkedFile[] {
  const results: WalkedFile[] = [];
  for (const filePath of filePaths) {
    const fullPath = filePath.startsWith("/") ? filePath : join(repoRoot, filePath);
    if (!existsSync(fullPath)) continue;
    const ext = extname(fullPath);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    const raw = readFileSync(fullPath);
    const hash = hashContent(raw);
    const relPath = relative(repoRoot, fullPath);
    results.push({ path: relPath, fullPath, ext, hash, content: raw.toString("utf-8") });
  }
  return results;
}

function isArtifactFile(name: string): boolean {
  if (ARTIFACT_GLOBS.has(name)) return true;
  if (name.startsWith(".env")) return true;
  const ext = extname(name);
  if (ARTIFACT_EXTENSIONS.has(ext)) return true;
  // Check for openapi files
  if (name.startsWith("openapi.")) return true;
  return false;
}

function walkArtifactFiles(
  dir: string,
  repoRoot: string,
): { path: string; fullPath: string }[] {
  const results: { path: string; fullPath: string }[] = [];
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
        results.push(...walkArtifactFiles(fullPath, repoRoot));
      }
    } else if (stat.isFile() && isArtifactFile(name)) {
      results.push({ path: relative(repoRoot, fullPath), fullPath });
    }
  }
  return results;
}

export async function runUpdate(args: string[]): Promise<void> {
  const useFull = args.includes("--full");
  const targetedFiles = parseFilesFlag(args);
  const fileSet = new Set(targetedFiles ?? []);
  const rootArg = args.find((a) => !a.startsWith("--") && !fileSet.has(a));
  const ctx = getContext(rootArg);

  // When --files is provided, only process those files (fast path for hooks).
  // Otherwise, walk the entire repo (full scan).
  const sourceFiles = targetedFiles
    ? processTargetedFiles(targetedFiles, ctx.repoRoot)
    : walkSourceFiles(ctx.repoRoot, ctx.repoRoot);

  // Find stale files by hash comparison
  const staleFiles = ctx.store.findStaleFiles(
    sourceFiles.map((f) => ({ path: f.path, hash: f.hash })),
  );

  // Build knownFiles from DB when doing targeted update (avoids full walk),
  // or from the walked source files for full scan.
  const knownFiles = targetedFiles
    ? ctx.store.getFilePaths()
    : new Set(sourceFiles.map((f) => f.path));

  const staleSet = new Set(staleFiles);
  const dirtyFiles = sourceFiles.filter((f) => staleSet.has(f.path));

  // Mark stale + new files dirty (tracks need for SCIP reindex)
  for (const file of dirtyFiles) {
    ctx.store.markDirty(file.path);
  }

  // Update structural imports for dirty files (batch inserts for performance)
  for (const file of dirtyFiles) {
    const language = languageFromExt(file.ext);
    ctx.store.upsertFile({ path: file.path, language, hash: file.hash });

    // Use cached content from walkSourceFiles/processTargetedFiles to avoid re-reading
    const code = file.content ?? readFileSync(file.fullPath, "utf-8");
    const imports = extractImports(code, language);
    ctx.store.clearEdgesForFile(file.path);
    const edges = imports.map((imp) => ({
      source: file.path,
      target: resolveModulePath(imp.specifier, file.path, language, knownFiles),
      kind: "imports" as const,
      confidence: "structural" as const,
    }));
    ctx.store.insertEdges(edges);
  }

  // Also register any completely new files (only relevant for full scan)
  const newFiles = targetedFiles
    ? sourceFiles.filter((f) => !staleSet.has(f.path) && !ctx.store.getFile(f.path))
    : sourceFiles.filter((f) => !staleSet.has(f.path) && !ctx.store.getFile(f.path));
  for (const file of newFiles) {
    const language = languageFromExt(file.ext);
    ctx.store.upsertFile({ path: file.path, language, hash: file.hash });
    ctx.store.markDirty(file.path);

    // Use cached content from walkSourceFiles/processTargetedFiles to avoid re-reading
    const code = file.content ?? readFileSync(file.fullPath, "utf-8");
    const imports = extractImports(code, language);
    ctx.store.clearEdgesForFile(file.path);
    const edges = imports.map((imp) => ({
      source: file.path,
      target: resolveModulePath(imp.specifier, file.path, language, knownFiles),
      kind: "imports" as const,
      confidence: "structural" as const,
    }));
    ctx.store.insertEdges(edges);
  }

  // Record structural index timestamp
  ctx.store.setMeta("last_structural_index_ts", String(Date.now()));

  // Run SCIP indexers when dirty source files exist or --full forces it
  const indexerResults: { indexer: string; result: unknown }[] = [];
  const succeededProjectIds = new Set<string>();
  const hasDirtySourceFiles = ctx.store.getDirtyPaths().length > 0;

  // Only detect projects when SCIP indexing will actually run.
  // For targeted single-file updates with no dirty source files,
  // this avoids a full repo walk (~20-50ms savings per hook invocation).
  const projects = (useFull || hasDirtySourceFiles) ? detectProjects(ctx.repoRoot) : [];

  if (useFull || hasDirtySourceFiles) {
    const tsIndexer = new ScipTypescriptIndexer();
    const pyIndexer = new ScipPythonIndexer();

    // Helper: run a SCIP indexer safely — surface errors instead of swallowing
    async function runScipIndexer(
      indexer: { name: string; run: typeof tsIndexer.run },
      projectId?: string,
      targetDir?: string,
    ): Promise<void> {
      const result = indexer.run(ctx.repoRoot, targetDir ? { targetDir, projectId } : undefined);

      if (!result.scipFilePath || !existsSync(result.scipFilePath)) {
        indexerResults.push({
          indexer: indexer.name,
          result: { errors: result.errors, projectId, warning: "no SCIP index produced" },
        });
        return;
      }

      const parser = new ScipParser();
      const index = await parser.parse(result.scipFilePath);
      // Build file hash map for skip-unchanged; use bulk mode for full reindexes.
      // For targeted updates, include hashes from the DB for files not in sourceFiles.
      const fileHashes = new Map(sourceFiles.map((f) => [f.path, f.hash]));
      if (targetedFiles) {
        for (const dbFile of ctx.store.getAllFiles()) {
          if (!fileHashes.has(dbFile.path)) {
            fileHashes.set(dbFile.path, dbFile.hash);
          }
        }
      }
      const ingested = parser.ingest(index, ctx.store, ctx.repoRoot, projectId, {
        fileHashes,
        bulk: true,
      });
      indexerResults.push({
        indexer: indexer.name,
        result: { ...result, ...ingested, projectId },
      });
      succeededProjectIds.add(projectId ?? ".");
      if (projectId) {
        ctx.store.setProjectIndexTs(projectId, Date.now());
      }
    }

    // Collect all currently dirty file paths for selective reindexing
    const allDirtyPaths = ctx.store.getDirtyPaths().map((d) => d.path);
    const allChangedPaths = new Set([
      ...dirtyFiles.map((f) => f.path),
      ...newFiles.map((f) => f.path),
      ...allDirtyPaths,
    ]);

    if (projects.length > 0) {
      // Multi-project path: only reindex projects that have dirty files
      for (const project of projects) {
        // Register project in store (upsert is idempotent)
        ctx.store.upsertProject({
          project_id: project.projectId,
          root: project.projectId, // store relative path for DB consistency
          language: project.language,
          last_index_ts: ctx.store.getProject(project.projectId)?.last_index_ts ?? 0,
        });

        const projectHasDirtyFiles = [...allChangedPaths].some((filePath) =>
          fileInProject(filePath, project.projectId),
        );

        if (!projectHasDirtyFiles) {
          continue;
        }

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
    }
  }

  // Record full SCIP index timestamp and clear dirty set per successful project.
  // Only clear dirty flags for projects that actually indexed successfully —
  // a failed project keeps its dirty flags so the next run retries it.
  const scipRan = useFull || hasDirtySourceFiles;
  if (scipRan && succeededProjectIds.size > 0) {
    ctx.store.setMeta("last_full_scip_index_ts", String(Date.now()));
    if (projects.length === 0) {
      // Single-project repo: clear all dirty
      ctx.store.clearAllDirty();
    } else {
      // Multi-project: clear dirty only for files in successful projects
      for (const projectId of succeededProjectIds) {
        ctx.store.clearDirtyByPrefix(projectId);
      }
    }
  }

  // ── Artifact indexing ────────────────────────────────────────────────
  const artifactFiles = walkArtifactFiles(ctx.repoRoot, ctx.repoRoot);
  const allArtifactSymbols: ArtifactSymbol[] = [];

  for (const af of artifactFiles) {
    try {
      const content = readFileSync(af.fullPath, "utf-8");
      const symbols = extractArtifacts(af.path, content);
      for (const sym of symbols) {
        ctx.store.upsertSymbol({
          id: sym.id,
          kind: sym.kind,
          name: sym.name,
          file_path: sym.filePath,
          range_start: (sym.line << 16) | 0,
          range_end: (sym.line << 16) | 0,
        });
        allArtifactSymbols.push(sym);
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Scan dirty source files for config references
  if (allArtifactSymbols.length > 0) {
    const filesToScan = [...dirtyFiles, ...newFiles];
    for (const file of filesToScan) {
      try {
        const code = file.content ?? readFileSync(file.fullPath, "utf-8");
        const language = languageFromExt(file.ext);
        const refEdges = scanConfigRefs(code, file.path, language, allArtifactSymbols);
        for (const edge of refEdges) {
          ctx.store.insertEdge(edge);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  ctx.ledger.log("update", {
    staleCount: dirtyFiles.length,
    newCount: newFiles.length,
    full: useFull,
    scip: scipRan,
    indexers: indexerResults.map((r) => r.indexer),
  });

  ctx.db.close();

  output("update", {
    staleFiles: dirtyFiles.length,
    newFiles: newFiles.length,
    updated: dirtyFiles.length + newFiles.length,
    indexers: indexerResults,
  });
}
