import { readdirSync, readFileSync, statSync } from "fs";
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
  const rootArg = args.find((a) => !a.startsWith("--"));
  const ctx = getContext(rootArg);
  const sourceFiles = walkSourceFiles(ctx.repoRoot, ctx.repoRoot);

  // Register all files and extract structural imports
  for (const file of sourceFiles) {
    const content = readFileSync(file.fullPath);
    const hash = hashContent(content);
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

  // Run SCIP indexers if applicable
  const indexerResults: { indexer: string; result: unknown }[] = [];
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

  ctx.ledger.log("index", {
    fileCount: sourceFiles.length,
    indexers: indexerResults.map((r) => r.indexer),
  });

  ctx.db.close();

  console.log(
    JSON.stringify({
      fileCount: sourceFiles.length,
      indexers: indexerResults,
    }),
  );
}
