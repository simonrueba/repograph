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
  const dir = mkdtempSync(join(tmpdir(), "ariadne-detect-test-"));
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

  // ── Nested project detection (no workspaces, no root tsconfig) ────────

  describe("nested project detection (subdirectory scan)", () => {
    it("detects tsconfig.json in an immediate subdirectory", () => {
      const root = makeTempDir();

      // No workspaces, no root tsconfig
      writeJson(join(root, "package.json"), { name: "my-app" });

      // tsconfig in src/
      mkdirp(join(root, "src"));
      writeFileSync(join(root, "src", "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].projectId).toBe("src");
      expect(projects[0].language).toBe("typescript");
    });

    it("detects pyproject.toml in an immediate subdirectory", () => {
      const root = makeTempDir();

      mkdirp(join(root, "backend"));
      writeFileSync(join(root, "backend", "pyproject.toml"), "[build-system]\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].projectId).toBe("backend");
      expect(projects[0].language).toBe("python");
    });

    it("skips node_modules and hidden directories during subdirectory scan", () => {
      const root = makeTempDir();

      // Create a tsconfig inside node_modules (should be skipped)
      mkdirp(join(root, "node_modules", "some-pkg"));
      writeFileSync(join(root, "node_modules", "some-pkg", "tsconfig.json"), "{}", "utf-8");

      // Create a tsconfig inside .hidden dir (should be skipped)
      mkdirp(join(root, ".hidden"));
      writeFileSync(join(root, ".hidden", "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(0);
    });

    it("prefers root tsconfig over subdirectory scan", () => {
      const root = makeTempDir();

      // Root has tsconfig
      writeFileSync(join(root, "tsconfig.json"), "{}", "utf-8");

      // Subdirectory also has tsconfig
      mkdirp(join(root, "src"));
      writeFileSync(join(root, "src", "tsconfig.json"), "{}", "utf-8");

      const projects = detectProjects(root);

      // Should detect root project, not subdirectory
      expect(projects).toHaveLength(1);
      expect(projects[0].projectId).toBe(".");
    });
  });

  // ── Go and Rust project detection ───────────────────────────────────

  describe("Go project detection", () => {
    it("detects Go project from go.mod at root", () => {
      const root = makeTempDir();
      writeFileSync(join(root, "go.mod"), "module example.com/myapp\n\ngo 1.21\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("go");
      expect(projects[0].projectId).toBe(".");
    });

    it("detects Go project in subdirectory", () => {
      const root = makeTempDir();
      mkdirp(join(root, "services"));
      writeFileSync(join(root, "services", "go.mod"), "module example.com/svc\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("go");
      expect(projects[0].projectId).toBe("services");
    });
  });

  describe("Rust project detection", () => {
    it("detects Rust project from Cargo.toml at root", () => {
      const root = makeTempDir();
      writeFileSync(join(root, "Cargo.toml"), "[package]\nname = \"myapp\"\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("rust");
      expect(projects[0].projectId).toBe(".");
    });

    it("detects Rust project in subdirectory", () => {
      const root = makeTempDir();
      mkdirp(join(root, "crates"));
      writeFileSync(join(root, "crates", "Cargo.toml"), "[package]\nname = \"lib\"\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("rust");
      expect(projects[0].projectId).toBe("crates");
    });
  });

  describe("Java project detection", () => {
    it("detects Java project from pom.xml at root", () => {
      const root = makeTempDir();
      writeFileSync(join(root, "pom.xml"), "<project></project>\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("java");
      expect(projects[0].projectId).toBe(".");
    });

    it("detects Java project from build.gradle", () => {
      const root = makeTempDir();
      writeFileSync(join(root, "build.gradle"), "apply plugin: 'java'\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("java");
    });

    it("detects Java project from build.gradle.kts", () => {
      const root = makeTempDir();
      writeFileSync(join(root, "build.gradle.kts"), "plugins { java }\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("java");
    });
  });

  describe("C# project detection", () => {
    it("detects C# project from .sln file", () => {
      const root = makeTempDir();
      writeFileSync(join(root, "MyApp.sln"), "Microsoft Visual Studio Solution\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("csharp");
      expect(projects[0].projectId).toBe(".");
    });

    it("detects C# project from .csproj file", () => {
      const root = makeTempDir();
      writeFileSync(join(root, "MyApp.csproj"), "<Project></Project>\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("csharp");
    });
  });

  describe("Scala project detection", () => {
    it("detects Scala project from build.sbt at root", () => {
      const root = makeTempDir();
      writeFileSync(join(root, "build.sbt"), 'name := "myapp"\n', "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("scala");
      expect(projects[0].projectId).toBe(".");
    });

    it("detects Scala project in subdirectory", () => {
      const root = makeTempDir();
      mkdirp(join(root, "services"));
      writeFileSync(join(root, "services", "build.sbt"), 'name := "svc"\n', "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("scala");
      expect(projects[0].projectId).toBe("services");
    });
  });

  describe("Ruby project detection", () => {
    it("detects Ruby project from Gemfile at root", () => {
      const root = makeTempDir();
      writeFileSync(join(root, "Gemfile"), "source 'https://rubygems.org'\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("ruby");
      expect(projects[0].projectId).toBe(".");
    });

    it("detects Ruby project in subdirectory", () => {
      const root = makeTempDir();
      mkdirp(join(root, "services"));
      writeFileSync(join(root, "services", "Gemfile"), "source 'https://rubygems.org'\n", "utf-8");

      const projects = detectProjects(root);

      expect(projects).toHaveLength(1);
      expect(projects[0].language).toBe("ruby");
      expect(projects[0].projectId).toBe("services");
    });
  });

  describe("multi-language with all eight languages", () => {
    it("detects all languages in a polyglot monorepo", () => {
      const root = makeTempDir();
      writeJson(join(root, "package.json"), { workspaces: ["packages/*"] });

      // TypeScript
      const tsDir = join(root, "packages", "web");
      mkdirp(tsDir);
      writeJson(join(tsDir, "package.json"), { name: "web" });
      writeFileSync(join(tsDir, "tsconfig.json"), "{}", "utf-8");

      // Go
      const goDir = join(root, "packages", "api");
      mkdirp(goDir);
      writeFileSync(join(goDir, "go.mod"), "module api\n", "utf-8");

      // Rust
      const rsDir = join(root, "packages", "engine");
      mkdirp(rsDir);
      writeFileSync(join(rsDir, "Cargo.toml"), "[package]\nname = \"engine\"\n", "utf-8");

      // Java
      const javaDir = join(root, "packages", "backend");
      mkdirp(javaDir);
      writeFileSync(join(javaDir, "pom.xml"), "<project></project>\n", "utf-8");

      // Scala
      const scalaDir = join(root, "packages", "analytics");
      mkdirp(scalaDir);
      writeFileSync(join(scalaDir, "build.sbt"), 'name := "analytics"\n', "utf-8");

      // C#
      const csDir = join(root, "packages", "desktop");
      mkdirp(csDir);
      writeFileSync(join(csDir, "App.csproj"), "<Project></Project>\n", "utf-8");

      // Ruby
      const rbDir = join(root, "packages", "worker");
      mkdirp(rbDir);
      writeFileSync(join(rbDir, "Gemfile"), "source 'https://rubygems.org'\n", "utf-8");

      const projects = detectProjects(root);

      const languages = projects.map((p) => p.language).sort();
      expect(languages).toEqual(["csharp", "go", "java", "ruby", "rust", "scala", "typescript"]);
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
