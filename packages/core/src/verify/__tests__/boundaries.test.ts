import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type AriadneDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { checkBoundaries } from "../checks/boundaries";

describe("checkBoundaries", () => {
  let db: AriadneDB;
  let queries: StoreQueries;
  let tempDir: string;
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-boundaries-test-"));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    tempDir = makeTempDir();
    db = createDatabase(join(tempDir, "test.db"));
    queries = new StoreQueries(db);
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("should pass when no config file exists", () => {
    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("should pass when all imports respect boundaries", () => {
    // Config: cli can import core
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), JSON.stringify({
      layers: {
        core: { path: "packages/core/", canImport: [] },
        cli: { path: "packages/cli/", canImport: ["core"] },
      }
    }));

    queries.upsertFile({ path: "packages/cli/src/main.ts", language: "typescript", hash: "h1" });
    queries.upsertFile({ path: "packages/core/src/lib.ts", language: "typescript", hash: "h2" });
    queries.insertEdge({ source: "packages/cli/src/main.ts", target: "packages/core/src/lib", kind: "imports" });

    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(true);
  });

  it("should detect boundary violations", () => {
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), JSON.stringify({
      layers: {
        core: { path: "packages/core/", canImport: [] },
        cli: { path: "packages/cli/", canImport: ["core"] },
      }
    }));

    queries.upsertFile({ path: "packages/core/src/lib.ts", language: "typescript", hash: "h1" });
    queries.upsertFile({ path: "packages/cli/src/main.ts", language: "typescript", hash: "h2" });
    // core importing from cli = violation
    queries.insertEdge({ source: "packages/core/src/lib.ts", target: "packages/cli/src/main", kind: "imports" });

    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe("BOUNDARY_VIOLATION");
    expect(result.issues[0].sourceLayer).toBe("core");
    expect(result.issues[0].targetLayer).toBe("cli");
  });

  it("should allow same-layer imports", () => {
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), JSON.stringify({
      layers: {
        core: { path: "packages/core/", canImport: [] },
      }
    }));

    queries.upsertFile({ path: "packages/core/src/a.ts", language: "typescript", hash: "h1" });
    queries.upsertFile({ path: "packages/core/src/b.ts", language: "typescript", hash: "h2" });
    queries.insertEdge({ source: "packages/core/src/a.ts", target: "packages/core/src/b", kind: "imports" });

    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(true);
  });

  it("should ignore non-imports edges", () => {
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), JSON.stringify({
      layers: {
        core: { path: "packages/core/", canImport: [] },
        cli: { path: "packages/cli/", canImport: [] },
      }
    }));

    queries.upsertFile({ path: "packages/core/src/lib.ts", language: "typescript", hash: "h1" });
    queries.insertEdge({ source: "packages/core/src/lib.ts", target: "packages/cli/src/main", kind: "references" });

    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(true);
  });

  it("should pass when config file contains invalid JSON", () => {
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), "{ not valid json }}}");
    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("should pass when layers object is empty", () => {
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), JSON.stringify({
      layers: {},
    }));
    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("should detect multiple violations across layers", () => {
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), JSON.stringify({
      layers: {
        core: { path: "src/core", canImport: [] },
        ui: { path: "src/ui", canImport: ["core"] },
        data: { path: "src/data", canImport: ["core"] },
      }
    }));

    // ui importing data = violation
    queries.insertEdge({ source: "src/ui/button.ts", target: "src/data/repo", kind: "imports" });
    // data importing ui = violation
    queries.insertEdge({ source: "src/data/repo.ts", target: "src/ui/button", kind: "imports" });
    // core importing ui = violation
    queries.insertEdge({ source: "src/core/lib.ts", target: "src/ui/button", kind: "imports" });

    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(3);
  });

  it("should ignore files outside any defined layer", () => {
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), JSON.stringify({
      layers: {
        core: { path: "src/core", canImport: [] },
        ui: { path: "src/ui", canImport: ["core"] },
      }
    }));

    // File outside any layer importing from a layer — should be ignored
    queries.insertEdge({ source: "scripts/build.ts", target: "src/core/lib", kind: "imports" });
    // Layer importing from outside file — target outside any layer, should be ignored
    queries.insertEdge({ source: "src/core/lib.ts", target: "scripts/util", kind: "imports" });

    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("should match most specific layer when paths are nested", () => {
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), JSON.stringify({
      layers: {
        core: { path: "src/core", canImport: [] },
        coreInternal: { path: "src/core/internal", canImport: ["core"] },
      }
    }));

    // src/core/internal/secret.ts should match "coreInternal", not "core"
    // coreInternal importing from core is allowed
    queries.insertEdge({ source: "src/core/internal/secret.ts", target: "src/core/lib", kind: "imports" });

    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(true);
  });

  it("should detect violation for nested layer importing disallowed layer", () => {
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), JSON.stringify({
      layers: {
        core: { path: "src/core", canImport: [] },
        coreInternal: { path: "src/core/internal", canImport: [] },
        ui: { path: "src/ui", canImport: ["core"] },
      }
    }));

    // coreInternal importing ui = violation (canImport is empty)
    queries.insertEdge({ source: "src/core/internal/secret.ts", target: "src/ui/button", kind: "imports" });

    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].sourceLayer).toBe("coreInternal");
    expect(result.issues[0].targetLayer).toBe("ui");
  });

  it("should populate all fields on boundary issues", () => {
    writeFileSync(join(tempDir, "ariadne.boundaries.json"), JSON.stringify({
      layers: {
        core: { path: "src/core", canImport: [] },
        cli: { path: "src/cli", canImport: ["core"] },
      }
    }));

    queries.insertEdge({ source: "src/core/lib.ts", target: "src/cli/main", kind: "imports" });

    const result = checkBoundaries(queries, tempDir);
    expect(result.passed).toBe(false);
    const issue = result.issues[0];
    expect(issue.type).toBe("BOUNDARY_VIOLATION");
    expect(issue.sourceFile).toBe("src/core/lib.ts");
    expect(issue.sourceLayer).toBe("core");
    expect(issue.targetLayer).toBe("cli");
    expect(issue.importTarget).toBe("src/cli/main");
  });
});
