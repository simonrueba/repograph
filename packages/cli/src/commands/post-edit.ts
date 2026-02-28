import { readFileSync, existsSync } from "fs";
import { join, relative, extname } from "path";
import { extractImports, resolveModulePath } from "ariadne-core";
import { getContext } from "../lib/context";
import { output } from "../lib/output";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".scala", ".cs", ".rb"]);

function languageFromExt(ext: string): string {
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  if ([".js", ".jsx"].includes(ext)) return "javascript";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if ([".java", ".kt"].includes(ext)) return "java";
  if (ext === ".scala") return "scala";
  if (ext === ".cs") return "csharp";
  if (ext === ".rb") return "ruby";
  return "unknown";
}

function hashContent(content: Buffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/**
 * Combined post-edit command: dirty mark + targeted update + ledger log
 * in a single process invocation. Saves ~80-120ms vs 3 separate CLI calls.
 */
export function runPostEdit(args: string[]): void {
  const filePath = args[0];
  if (!filePath) return;

  const ctx = getContext();
  const fullPath = filePath.startsWith("/") ? filePath : join(ctx.repoRoot, filePath);
  const relPath = relative(ctx.repoRoot, fullPath);
  const ext = extname(fullPath);
  const isSource = SOURCE_EXTENSIONS.has(ext);

  // 1. Mark dirty (only source files)
  if (isSource) {
    ctx.store.markDirty(relPath);
  }

  // 2. Targeted update (hash check + import extraction, NO artifact walk)
  if (isSource && existsSync(fullPath)) {
    const raw = readFileSync(fullPath);
    const hash = hashContent(raw);

    const stale = ctx.store.findStaleFiles([{ path: relPath, hash }]);
    if (stale.length > 0 || !ctx.store.getFile(relPath)) {
      const language = languageFromExt(ext);
      const content = raw.toString("utf-8");
      ctx.store.upsertFile({ path: relPath, language, hash });

      // Build knownFiles from DB for module resolution (paths-only query)
      const knownFiles = ctx.store.getFilePaths();
      const imports = extractImports(content, language);
      ctx.store.clearEdgesForFile(relPath);
      const edges = imports.map((imp) => ({
        source: relPath,
        target: resolveModulePath(imp.specifier, relPath, language, knownFiles),
        kind: "imports" as const,
        confidence: "structural" as const,
      }));
      ctx.store.insertEdges(edges);
    }
  }

  // 3. Ledger log
  ctx.ledger.log("edit", { file: relPath });

  ctx.db.close();

  output("post-edit", { file: relPath });
}
