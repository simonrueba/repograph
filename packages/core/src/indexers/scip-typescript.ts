import { existsSync, mkdirSync, renameSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import type { Indexer, IndexResult } from "./types";

export class ScipTypescriptIndexer implements Indexer {
  readonly name = "scip-typescript";

  canIndex(repoRoot: string): boolean {
    return (
      existsSync(join(repoRoot, "tsconfig.json")) ||
      existsSync(join(repoRoot, "jsconfig.json"))
    );
  }

  run(
    repoRoot: string,
    opts?: { targetDir?: string; projectId?: string },
  ): IndexResult {
    const cwd = opts?.targetDir ?? repoRoot;
    const projectId = opts?.projectId ?? "root";
    const rawOutputPath = join(cwd, "index.scip");
    const cacheDir = join(repoRoot, ".repograph", "cache", "scip", projectId);
    mkdirSync(cacheDir, { recursive: true });
    const cachedPath = join(cacheDir, "index.scip");
    const errors: string[] = [];
    const start = performance.now();

    try {
      execSync(
        "npx --yes @sourcegraph/scip-typescript index --infer-tsconfig",
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
        errors.push(`scip-typescript exited with code ${err.status}`);
      }
    }

    // Move index.scip from repo root to cache directory
    if (existsSync(rawOutputPath)) {
      renameSync(rawOutputPath, cachedPath);
    }

    const duration = performance.now() - start;

    return {
      scipFilePath: existsSync(cachedPath) ? cachedPath : rawOutputPath,
      language: "typescript",
      filesIndexed: 0, // actual count determined after parsing the SCIP file
      errors,
      duration,
    };
  }
}
