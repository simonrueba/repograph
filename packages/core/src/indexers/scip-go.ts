import { existsSync, mkdirSync, renameSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import type { Indexer, IndexResult } from "./types";

export class ScipGoIndexer implements Indexer {
  readonly name = "scip-go";

  canIndex(repoRoot: string): boolean {
    return existsSync(join(repoRoot, "go.mod"));
  }

  run(
    repoRoot: string,
    opts?: { targetDir?: string; projectId?: string },
  ): IndexResult {
    const cwd = opts?.targetDir ?? repoRoot;
    const projectId = opts?.projectId ?? "root";
    const rawOutputPath = join(cwd, "index.scip");
    const cacheDir = join(repoRoot, ".ariadne", "cache", "scip", projectId);
    mkdirSync(cacheDir, { recursive: true });
    const cachedPath = join(cacheDir, "index-go.scip");
    const errors: string[] = [];
    const start = performance.now();

    try {
      execFileSync(
        "scip-go",
        ["index", "--output", rawOutputPath],
        {
          cwd,
          timeout: 120_000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (err: any) {
      const stderr = err.stderr?.toString().trim();
      if (stderr) {
        errors.push(stderr);
      }
      if (err.status !== 0 && !existsSync(rawOutputPath)) {
        errors.push(`scip-go exited with code ${err.status}`);
      }
    }

    // Move index.scip to cache directory
    if (existsSync(rawOutputPath)) {
      renameSync(rawOutputPath, cachedPath);
    }

    const duration = performance.now() - start;

    if (!existsSync(cachedPath)) {
      errors.push("no index.scip produced — scip-go may have failed or found no files to index");
    }

    return {
      scipFilePath: existsSync(cachedPath) ? cachedPath : "",
      language: "go",
      filesIndexed: 0,
      errors,
      duration,
    };
  }
}
