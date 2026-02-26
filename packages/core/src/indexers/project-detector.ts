import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative, resolve } from "path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DetectedProject {
  /** Relative path from repoRoot, e.g. "packages/core". "." for the root itself. */
  projectId: string;
  /** Absolute path to the project root directory. */
  root: string;
  language: "typescript" | "python";
  /** Absolute path to tsconfig.json, only present for TypeScript projects. */
  tsconfigPath?: string;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Expand a single workspace glob pattern like "packages/*" into a list of
 * absolute directory paths that exist and look like packages.
 *
 * Only handles the common `<parent>/*` style — no recursive `**` patterns.
 */
function expandWorkspaceGlob(repoRoot: string, pattern: string): string[] {
  // Strip trailing slash so split works cleanly.
  const normalized = pattern.replace(/\/+$/, "");

  if (!normalized.includes("*")) {
    // Literal path — just resolve and return if it exists.
    const abs = resolve(repoRoot, normalized);
    return existsSync(abs) && statSync(abs).isDirectory() ? [abs] : [];
  }

  const starIndex = normalized.indexOf("*");
  const prefix = normalized.slice(0, starIndex);   // e.g. "packages/"
  const suffix = normalized.slice(starIndex + 1);  // e.g. "" for "packages/*"

  // The directory that contains the wildcard entries.
  const parentDir = resolve(repoRoot, prefix.replace(/\/$/, "") || ".");

  if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(parentDir);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    // The suffix after "*" must be matched literally.
    if (suffix && !entry.endsWith(suffix)) continue;

    const abs = join(parentDir, entry);
    if (!statSync(abs).isDirectory()) continue;

    // The directory must have at least one indicator that it is a project.
    const hasPackageJson = existsSync(join(abs, "package.json"));
    const hasTsconfig = existsSync(join(abs, "tsconfig.json"));
    const hasPyproject = existsSync(join(abs, "pyproject.toml"));
    const hasSetupPy = existsSync(join(abs, "setup.py"));

    if (hasPackageJson || hasTsconfig || hasPyproject || hasSetupPy) {
      results.push(abs);
    }
  }

  return results;
}

/**
 * Derive projects from a single directory that is known to exist.
 * May return 0, 1 or 2 entries (one per detected language).
 */
function projectsFromDir(
  repoRoot: string,
  absDir: string,
): DetectedProject[] {
  const projectId = relative(repoRoot, absDir) || ".";
  const detected: DetectedProject[] = [];

  const tsconfigPath = join(absDir, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    detected.push({
      projectId,
      root: absDir,
      language: "typescript",
      tsconfigPath,
    });
  }

  const hasPyproject = existsSync(join(absDir, "pyproject.toml"));
  const hasSetupPy = existsSync(join(absDir, "setup.py"));
  if (hasPyproject || hasSetupPy) {
    detected.push({
      projectId,
      root: absDir,
      language: "python",
    });
  }

  return detected;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan `repoRoot` for sub-projects, respecting workspace configurations.
 *
 * Detection strategy:
 * 1. Read `package.json` at `repoRoot`. If it has a `workspaces` field
 *    (array of globs), expand those globs to find package directories.
 * 2. For each workspace package directory, detect TypeScript (tsconfig.json)
 *    and/or Python (pyproject.toml / setup.py) projects.
 * 3. If no workspace packages are found, treat the repo root itself as a
 *    single project and detect its language(s).
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns Array of detected projects. May be empty if the directory is not
 *          a recognisable project.
 */
export function detectProjects(repoRoot: string): DetectedProject[] {
  const absRoot = resolve(repoRoot);

  // ── Step 1: try to read workspaces from root package.json ───────────────
  const pkgJsonPath = join(absRoot, "package.json");
  let workspaceGlobs: string[] = [];

  if (existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(
        readFileSync(pkgJsonPath, "utf-8"),
      ) as Record<string, unknown>;

      if (Array.isArray(pkgJson["workspaces"])) {
        workspaceGlobs = pkgJson["workspaces"] as string[];
      } else if (
        pkgJson["workspaces"] !== null &&
        typeof pkgJson["workspaces"] === "object" &&
        Array.isArray((pkgJson["workspaces"] as Record<string, unknown>)["packages"])
      ) {
        // Yarn "workspaces": { "packages": [...] } variant.
        workspaceGlobs = (
          pkgJson["workspaces"] as Record<string, unknown>
        )["packages"] as string[];
      }
    } catch {
      // Malformed package.json — fall through to root detection.
    }
  }

  // ── Step 2: expand workspace globs ──────────────────────────────────────
  const workspaceDirs: string[] = [];
  for (const glob of workspaceGlobs) {
    const expanded = expandWorkspaceGlob(absRoot, glob);
    workspaceDirs.push(...expanded);
  }

  if (workspaceDirs.length > 0) {
    const results: DetectedProject[] = [];
    for (const dir of workspaceDirs) {
      results.push(...projectsFromDir(absRoot, dir));
    }
    return results;
  }

  // ── Step 3: no workspaces — treat the repo root as the single project ───
  const rootProjects = projectsFromDir(absRoot, absRoot);
  if (rootProjects.length > 0) {
    return rootProjects;
  }

  // ── Step 4: scan immediate subdirectories for nested projects ───────────
  // Catches repos where tsconfig.json / pyproject.toml lives in src/, app/, etc.
  return scanSubdirectories(absRoot);
}

/**
 * Scan immediate subdirectories (depth 1) for project config files.
 * Skips common non-project directories (node_modules, dist, .git, etc.).
 */
function scanSubdirectories(absRoot: string): DetectedProject[] {
  const skipDirs = new Set([
    "node_modules", "dist", "build", "out", ".git", ".repograph",
    ".next", ".nuxt", ".svelte-kit", "coverage", "__pycache__", ".venv", "venv",
  ]);

  let entries: string[];
  try {
    entries = readdirSync(absRoot);
  } catch {
    return [];
  }

  const results: DetectedProject[] = [];
  for (const entry of entries) {
    if (skipDirs.has(entry) || entry.startsWith(".")) continue;

    const absDir = join(absRoot, entry);
    try {
      if (!statSync(absDir).isDirectory()) continue;
    } catch {
      continue;
    }

    results.push(...projectsFromDir(absRoot, absDir));
  }

  return results;
}
