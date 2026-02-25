import { readdirSync, readFileSync } from "fs";
import { join, relative, extname } from "path";
import {
  extractImports,
  resolveModulePath,
  ScipTypescriptIndexer,
  ScipPythonIndexer,
  ScipParser,
} from "repograph-core";
import { getContext } from "../lib/context";

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
): { path: string; fullPath: string; ext: string; hash: string }[] {
  const results: { path: string; fullPath: string; ext: string; hash: string }[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const name = String(entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith(".")) {
        results.push(...walkSourceFiles(join(dir, name), repoRoot));
      }
    } else if (entry.isFile()) {
      const ext = extname(name);
      if (SOURCE_EXTENSIONS.has(ext)) {
        const fullPath = join(dir, name);
        const content = readFileSync(fullPath);
        const hash = hashContent(content);
        results.push({ path: relative(repoRoot, fullPath), fullPath, ext, hash });
      }
    }
  }
  return results;
}

export async function runUpdate(args: string[]): Promise<void> {
  const useFull = args.includes("--full");
  const rootArg = args.find((a) => !a.startsWith("--"));
  const ctx = getContext(rootArg);

  const sourceFiles = walkSourceFiles(ctx.repoRoot, ctx.repoRoot);

  // Find stale files by hash comparison
  const staleFiles = ctx.store.findStaleFiles(
    sourceFiles.map((f) => ({ path: f.path, hash: f.hash })),
  );

  const staleSet = new Set(staleFiles);
  const dirtyFiles = sourceFiles.filter((f) => staleSet.has(f.path));

  // Update structural imports for dirty files
  for (const file of dirtyFiles) {
    const language = languageFromExt(file.ext);
    ctx.store.upsertFile({ path: file.path, language, hash: file.hash });

    const code = readFileSync(file.fullPath, "utf-8");
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

  // Also register any completely new files
  const newFiles = sourceFiles.filter(
    (f) => !staleSet.has(f.path) && !ctx.store.getFile(f.path),
  );
  for (const file of newFiles) {
    const language = languageFromExt(file.ext);
    ctx.store.upsertFile({ path: file.path, language, hash: file.hash });

    const code = readFileSync(file.fullPath, "utf-8");
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

  // Run SCIP indexers if --full
  const indexerResults: { indexer: string; result: unknown }[] = [];
  if (useFull) {
    const tsIndexer = new ScipTypescriptIndexer();
    const pyIndexer = new ScipPythonIndexer();

    if (tsIndexer.canIndex(ctx.repoRoot)) {
      try {
        const result = tsIndexer.run(ctx.repoRoot);
        const parser = new ScipParser();
        const index = await parser.parse(result.scipFilePath);
        const ingested = parser.ingest(index, ctx.store, ctx.repoRoot);
        indexerResults.push({
          indexer: "scip-typescript",
          result: { ...result, ...ingested },
        });
      } catch (err: any) {
        indexerResults.push({
          indexer: "scip-typescript",
          result: { error: err.message },
        });
      }
    }

    if (pyIndexer.canIndex(ctx.repoRoot)) {
      try {
        const result = pyIndexer.run(ctx.repoRoot);
        const parser = new ScipParser();
        const index = await parser.parse(result.scipFilePath);
        const ingested = parser.ingest(index, ctx.store, ctx.repoRoot);
        indexerResults.push({
          indexer: "scip-python",
          result: { ...result, ...ingested },
        });
      } catch (err: any) {
        indexerResults.push({
          indexer: "scip-python",
          result: { error: err.message },
        });
      }
    }
  }

  ctx.ledger.log("update", {
    staleCount: dirtyFiles.length,
    newCount: newFiles.length,
    full: useFull,
    indexers: indexerResults.map((r) => r.indexer),
  });

  ctx.db.close();

  console.log(
    JSON.stringify({
      staleFiles: dirtyFiles.length,
      newFiles: newFiles.length,
      updated: dirtyFiles.length + newFiles.length,
      indexers: indexerResults,
    }),
  );
}
