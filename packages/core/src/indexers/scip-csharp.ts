import { existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import type { Indexer, IndexResult } from "./types";

export class ScipCsharpIndexer implements Indexer {
  readonly name = "scip-dotnet";

  canIndex(repoRoot: string): boolean {
    // Check for .sln or .csproj files
    if (existsSync(join(repoRoot, "*.sln"))) return true;
    try {
      const entries = readdirSync(repoRoot);
      return entries.some((e) => e.endsWith(".sln") || e.endsWith(".csproj"));
    } catch {
      return false;
    }
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
    const cachedPath = join(cacheDir, "index-csharp.scip");
    const errors: string[] = [];
    const start = performance.now();

    try {
      execFileSync(
        "scip-dotnet",
        ["index", "--output", rawOutputPath],
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
        errors.push(`scip-dotnet exited with code ${err.status}`);
      }
    }

    if (existsSync(rawOutputPath)) {
      renameSync(rawOutputPath, cachedPath);
    }

    const duration = performance.now() - start;

    if (!existsSync(cachedPath)) {
      errors.push("no index.scip produced — scip-dotnet may have failed or found no files to index");
    }

    return {
      scipFilePath: existsSync(cachedPath) ? cachedPath : "",
      language: "csharp",
      filesIndexed: 0,
      errors,
      duration,
    };
  }
}
