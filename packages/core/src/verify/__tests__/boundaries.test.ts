import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type RepographDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { checkBoundaries } from "../checks/boundaries";

describe("checkBoundaries", () => {
  let db: RepographDB;
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
});
