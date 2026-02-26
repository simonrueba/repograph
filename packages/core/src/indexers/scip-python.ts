import { existsSync, mkdirSync, renameSync } from "fs";
import { execSync } from "child_process";
import { join, basename } from "path";
import type { Indexer, IndexResult } from "./types";

export class ScipPythonIndexer implements Indexer {
  readonly name = "scip-python";

  canIndex(repoRoot: string): boolean {
    return (
      existsSync(join(repoRoot, "pyproject.toml")) ||
      existsSync(join(repoRoot, "setup.py")) ||
      existsSync(join(repoRoot, "requirements.txt"))
    );
  }

  run(
    repoRoot: string,
    opts?: { targetDir?: string; projectId?: string },
  ): IndexResult {
    const cwd = opts?.targetDir ?? repoRoot;
    const projectId = opts?.projectId ?? "root";
    const projectName = basename(cwd);
    const cacheDir = join(repoRoot, ".repograph", "cache", "scip", projectId);
    mkdirSync(cacheDir, { recursive: true });
    const cachedPath = join(cacheDir, "index-python.scip");
    const errors: string[] = [];
    const start = performance.now();

    try {
      execSync(
        `uvx scip-python index ${cwd} --project-name=${projectName} --output=${cachedPath}`,
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
      if (err.status !== 0 && !existsSync(cachedPath)) {
        errors.push(`scip-python exited with code ${err.status}`);
      }
    }

    const duration = performance.now() - start;

    return {
      scipFilePath: cachedPath,
      language: "python",
      filesIndexed: 0, // actual count determined after parsing the SCIP file
      errors,
      duration,
    };
  }
}
