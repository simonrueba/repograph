import { existsSync, mkdirSync, renameSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import type { Indexer, IndexResult } from "./types";

export class ScipRubyIndexer implements Indexer {
  readonly name = "scip-ruby";

  canIndex(repoRoot: string): boolean {
    return existsSync(join(repoRoot, "Gemfile"));
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
    const cachedPath = join(cacheDir, "index-ruby.scip");
    const errors: string[] = [];
    const start = performance.now();

    try {
      execFileSync(
        "scip-ruby",
        ["--index-file", rawOutputPath],
        {
          cwd,
          timeout: 180_000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (err: any) {
      const stderr = err.stderr?.toString().trim();
      if (stderr) {
        errors.push(stderr);
      }
      if (err.status !== 0 && !existsSync(rawOutputPath)) {
        errors.push(`scip-ruby exited with code ${err.status}`);
      }
    }

    if (existsSync(rawOutputPath)) {
      renameSync(rawOutputPath, cachedPath);
    }

    const duration = performance.now() - start;

    if (!existsSync(cachedPath)) {
      errors.push("no index.scip produced — scip-ruby may have failed or found no files to index");
    }

    return {
      scipFilePath: existsSync(cachedPath) ? cachedPath : "",
      language: "ruby",
      filesIndexed: 0,
      errors,
      duration,
    };
  }
}
