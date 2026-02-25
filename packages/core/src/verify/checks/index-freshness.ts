import type { StoreQueries } from "../../store/queries";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

export interface FreshnessIssue {
  type: "STALE_INDEX";
  path: string;
  reason: string;
}

export interface FreshnessResult {
  passed: boolean;
  issues: FreshnessIssue[];
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".repograph"]);

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

function isSourceFile(name: string): boolean {
  const ext = name.substring(name.lastIndexOf("."));
  return SOURCE_EXTENSIONS.has(ext);
}

function hashFile(fullPath: string): string {
  const content = readFileSync(fullPath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/** Recursively walk the repo, collecting source files (skipping ignored dirs). */
function walkSourceFiles(dir: string, repoRoot: string): { path: string; hash: string }[] {
  const results: { path: string; hash: string }[] = [];

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
      if (!shouldSkipDir(name)) {
        results.push(...walkSourceFiles(fullPath, repoRoot));
      }
    } else if (stat.isFile() && isSourceFile(name)) {
      const relPath = relative(repoRoot, fullPath);
      results.push({ path: relPath, hash: hashFile(fullPath) });
    }
  }

  return results;
}

/**
 * Check whether every source file on disk matches its indexed hash.
 * Returns STALE_INDEX issues for files that differ or are unindexed.
 */
export function checkIndexFreshness(
  store: StoreQueries,
  repoRoot: string,
): FreshnessResult {
  const diskFiles = walkSourceFiles(repoRoot, repoRoot);
  const issues: FreshnessIssue[] = [];

  // Check disk files against the index
  for (const file of diskFiles) {
    const indexed = store.getFile(file.path);
    if (!indexed) {
      issues.push({
        type: "STALE_INDEX",
        path: file.path,
        reason: "file not indexed",
      });
    } else if (indexed.hash !== file.hash) {
      issues.push({
        type: "STALE_INDEX",
        path: file.path,
        reason: "hash mismatch (file changed since last index)",
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}
