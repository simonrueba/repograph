import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectProjects } from "../project-detector";

// ── Helpers ───────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

/**
 * Create a fresh temporary directory rooted in the OS tmpdir, register it for
 * cleanup, and return its absolute path.
 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "repograph-detect-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Write `content` (a plain object or string) to `filePath` in JSON. */
function writeJson(filePath: string, content: unknown): void {
  writeFileSync(filePath, JSON.stringify(content, null, 2), "utf-8");
}

/** Ensure `dirPath` and any missing ancestor directories exist. */
function mkdirp(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("detectProjects", () => {
  // ── Monorepo with workspaces ────────────────────────────────────────────

  describe("monorepo with workspaces (array syntax)", () => {
    it("detects each workspace package as a separate project", () => {
      const root = makeTempDir();

      // Root package.json declaring workspaces
      writeJson(join(root, "package.json"), {
        name: "my-monorepo",
        workspaces: ["packages/*"],
      });

      // packages/app — TypeScript project
      const appDir = join(root, "packages", "app");
      mkdirp(appDir);
      writeJson(join(appDir, "package.json"), { name: "app" });
      writeFileSync(join(appDir, "tsconfig.json"), "{}", "utf-8");

      // packages/lib — TypeScript project
      const libDir = join(root, "packages", "lib");
      mkdirp(libDir);
      writeJson(join(libDir, "package.json"), { name: "lib" });
      writeFileSync(join(libDir, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(2);

      const ids = projects.map((p) => p.projectId).sort();
      expect(ids).toContain("packages/app");
      expect(ids).toContain("packages/lib");
    });

    it("assigns correct absolute root paths to each project", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), { workspaces: ["packages/*"] });

      const appDir = join(root, "packages", "app");
      mkdirp(appDir);
      writeJson(join(appDir, "package.json"), { name: "app" });
      writeFileSync(join(appDir, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].root).toBe(appDir);
    });

    it("marks workspace TypeScript packages with language 'typescript'", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), { workspaces: ["packages/*"] });

      const pkgDir = join(root, "packages", "core");
      mkdirp(pkgDir);
      writeJson(join(pkgDir, "package.json"), { name: "core" });
      writeFileSync(join(pkgDir, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("typescript");
      expect(projects[0].tsconfigPath).toBe(join(pkgDir, "tsconfig.json"));
    });
  });

  // ── Single-project repo (no workspaces) ───────────────────────────────

  describe("single-project repo (no workspaces field)", () => {
    it("returns one project with projectId '.'", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), { name: "my-app" });
      writeFileSync(join(root, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].projectId).toBe(".");
    });

    it("sets root to the repo root absolute path", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), { name: "my-app" });
      writeFileSync(join(root, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects[0].root).toBe(root);
    });

    it("sets language to 'typescript' when tsconfig.json is present", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), { name: "my-app" });
      writeFileSync(join(root, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects[0].language).toBe("typescript");
      expect(projects[0].tsconfigPath).toBe(join(root, "tsconfig.json"));
    });

    it("returns empty array when the root has neither tsconfig.json nor pyproject.toml", () => {
      const root = makeTempDir();

      // package.json without workspaces and no other language indicators
      writeJson(join(root, "package.json"), { name: "just-scripts" });

      const projects = detectProjects(root);

      // projectsFromDir finds no language indicators → returns nothing
      expect(projects).toHaveLength(0);
    });
  });

  // ── Mixed language monorepo ────────────────────────────────────────────

  describe("mixed language monorepo (TS + Python)", () => {
    it("detects TypeScript and Python packages from the same workspace", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), { workspaces: ["packages/*"] });

      // TypeScript package
      const tsDir = join(root, "packages", "frontend");
      mkdirp(tsDir);
      writeJson(join(tsDir, "package.json"), { name: "frontend" });
      writeFileSync(join(tsDir, "tsconfig.json"), "{}", "utf-8");

      // Python package — uses pyproject.toml
      const pyDir = join(root, "packages", "ml-service");
      mkdirp(pyDir);
      writeFileSync(join(pyDir, "pyproject.toml"), "[build-system]\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(2);

      const languages = projects.map((p) => p.language).sort();
      expect(languages).toContain("typescript");
      expect(languages).toContain("python");
    });

    it("detects Python package that uses setup.py instead of pyproject.toml", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), { workspaces: ["services/*"] });

      const svcDir = join(root, "services", "worker");
      mkdirp(svcDir);
      writeFileSync(join(svcDir, "setup.py"), "from setuptools import setup\nsetup()\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("python");
      expect(projects[0].projectId).toBe("services/worker");
    });

    it("emits two DetectedProject entries for a dir that has both tsconfig.json and pyproject.toml", () => {
      const root = makeTempDir();

      // Single workspace package that is both TS and Python (unusual but valid)
      writeJson(join(root, "package.json"), { workspaces: ["packages/*"] });

      const polyDir = join(root, "packages", "polyglot");
      mkdirp(polyDir);
      writeJson(join(polyDir, "package.json"), { name: "polyglot" });
      writeFileSync(join(polyDir, "tsconfig.json"), "{}", "utf-8");
      writeFileSync(join(polyDir, "pyproject.toml"), "[build-system]\n", "utf-8");

      const projects = detectProjects(root);

      // projectsFromDir emits one entry per detected language
      expect(projects).toHaveLength(2);

      const langs = projects.map((p) => p.language).sort();
      expect(langs).toEqual(["python", "typescript"]);

      // Both share the same projectId
      expect(projects.every((p) => p.projectId === "packages/polyglot")).toBe(true);
    });
  });

  // ── Empty workspace ────────────────────────────────────────────────────

  describe("empty workspace (packages/ dir does not exist)", () => {
    it("falls back to root project detection when glob expands to nothing", () => {
      const root = makeTempDir();

      // Declares workspaces but the packages/ directory does not exist
      writeJson(join(root, "package.json"), { workspaces: ["packages/*"] });

      // Make the root itself a recognisable project
      writeFileSync(join(root, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      // workspaceDirs is empty → falls through to root detection
      expect(projects).toHaveLength(1);
      expect(projects[0].projectId).toBe(".");
    });

    it("returns empty array when root is also not a recognisable project", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), { workspaces: ["packages/*"] });
      // No tsconfig.json, no pyproject.toml at root

      const projects = detectProjects(root);

      expect(projects).toHaveLength(0);
    });

    it("ignores workspace dirs that have no language indicators", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), { workspaces: ["packages/*"] });

      // A directory that has no package.json, tsconfig.json, pyproject.toml, or setup.py
      // → expandWorkspaceGlob will not include it at all
      const emptyPkg = join(root, "packages", "empty-thing");
      mkdirp(emptyPkg);
      // Only a random text file — not a project indicator
      writeFileSync(join(emptyPkg, "README.md"), "hello\n", "utf-8");

      const projects = detectProjects(root);

      // Falls back to root detection (no tsconfig.json either) → empty
      expect(projects).toHaveLength(0);
    });
  });

  // ── Yarn-style workspaces object ──────────────────────────────────────

  describe("Yarn-style workspaces object ({ packages: [...] })", () => {
    it("detects packages declared under the 'packages' key", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), {
        name: "yarn-monorepo",
        workspaces: {
          packages: ["packages/*"],
        },
      });

      const appDir = join(root, "packages", "app");
      mkdirp(appDir);
      writeJson(join(appDir, "package.json"), { name: "app" });
      writeFileSync(join(appDir, "tsconfig.json"), "{}", "utf-8");

      const libDir = join(root, "packages", "lib");
      mkdirp(libDir);
      writeJson(join(libDir, "package.json"), { name: "lib" });
      writeFileSync(join(libDir, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(2);

      const ids = projects.map((p) => p.projectId).sort();
      expect(ids).toContain("packages/app");
      expect(ids).toContain("packages/lib");
    });

    it("assigns language 'typescript' to Yarn workspace TS packages", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), {
        workspaces: { packages: ["apps/*"] },
      });

      const webDir = join(root, "apps", "web");
      mkdirp(webDir);
      writeJson(join(webDir, "package.json"), { name: "web" });
      writeFileSync(join(webDir, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("typescript");
    });

    it("falls back to root detection when Yarn workspace glob expands to nothing", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), {
        workspaces: { packages: ["nonexistent/*"] },
      });

      writeFileSync(join(root, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].projectId).toBe(".");
    });
  });

  // ── Malformed / edge cases ─────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns empty array for an entirely empty directory", () => {
      const root = makeTempDir();

      const projects = detectProjects(root);

      expect(projects).toHaveLength(0);
    });

    it("falls back to root detection when package.json is malformed JSON", () => {
      const root = makeTempDir();

      writeFileSync(join(root, "package.json"), "{ this is: not valid JSON", "utf-8");
      writeFileSync(join(root, "tsconfig.json"), "{}", "utf-8");

      // malformed package.json → caught → workspaceGlobs stays [] → root detection
      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].projectId).toBe(".");
    });

    it("handles literal (non-glob) workspace paths", () => {
      const root = makeTempDir();

      writeJson(join(root, "package.json"), { workspaces: ["shared"] });

      const sharedDir = join(root, "shared");
      mkdirp(sharedDir);
      writeJson(join(sharedDir, "package.json"), { name: "shared" });
      writeFileSync(join(sharedDir, "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].projectId).toBe("shared");
    });
  });
});
