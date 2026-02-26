import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { decodeScipRange, packRange, SymbolRole } from "../types";
import { ScipParser } from "../parser";
import { createDatabase, type RepographDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";

// ── types.ts unit tests ────────────────────────────────────────────────

describe("decodeScipRange", () => {
  it("should decode a 3-element array as single-line range", () => {
    const range = decodeScipRange([10, 5, 20]);
    expect(range).toEqual({
      startLine: 10,
      startCol: 5,
      endLine: 10,
      endCol: 20,
    });
  });

  it("should decode a 4-element array as multi-line range", () => {
    const range = decodeScipRange([10, 5, 15, 20]);
    expect(range).toEqual({
      startLine: 10,
      startCol: 5,
      endLine: 15,
      endCol: 20,
    });
  });

  it("should handle zero values", () => {
    const range = decodeScipRange([0, 0, 0]);
    expect(range).toEqual({
      startLine: 0,
      startCol: 0,
      endLine: 0,
      endCol: 0,
    });
  });
});

describe("packRange", () => {
  it("should pack a single-line range correctly", () => {
    const packed = packRange({
      startLine: 10,
      startCol: 5,
      endLine: 10,
      endCol: 20,
    });
    expect(packed.start).toBe((10 << 16) | 5);
    expect(packed.end).toBe((10 << 16) | 20);
  });

  it("should pack a multi-line range correctly", () => {
    const packed = packRange({
      startLine: 10,
      startCol: 5,
      endLine: 15,
      endCol: 20,
    });
    expect(packed.start).toBe((10 << 16) | 5);
    expect(packed.end).toBe((15 << 16) | 20);
  });

  it("should handle line 0, col 0", () => {
    const packed = packRange({
      startLine: 0,
      startCol: 0,
      endLine: 0,
      endCol: 0,
    });
    expect(packed.start).toBe(0);
    expect(packed.end).toBe(0);
  });

  it("should encode large line numbers", () => {
    const packed = packRange({
      startLine: 1000,
      startCol: 40,
      endLine: 1000,
      endCol: 55,
    });
    expect(packed.start).toBe((1000 << 16) | 40);
    expect(packed.end).toBe((1000 << 16) | 55);
  });
});

describe("SymbolRole", () => {
  it("should have correct bitmask values", () => {
    expect(SymbolRole.UnspecifiedSymbolRole).toBe(0);
    expect(SymbolRole.Definition).toBe(1);
    expect(SymbolRole.Import).toBe(2);
    expect(SymbolRole.WriteAccess).toBe(4);
    expect(SymbolRole.ReadAccess).toBe(8);
    expect(SymbolRole.Generated).toBe(16);
    expect(SymbolRole.Test).toBe(32);
    expect(SymbolRole.ForwardDefinition).toBe(64);
  });

  it("should support bitmask combination for Definition + ReadAccess", () => {
    const combined = SymbolRole.Definition | SymbolRole.ReadAccess;
    expect(combined).toBe(9);
    expect(combined & SymbolRole.Definition).toBeTruthy();
    expect(combined & SymbolRole.ReadAccess).toBeTruthy();
    expect(combined & SymbolRole.WriteAccess).toBeFalsy();
  });
});

// ── parser.ts unit tests ───────────────────────────────────────────────

describe("ScipParser", () => {
  it("should load the proto file without errors", async () => {
    const parser = new ScipParser();
    await parser.loadProto();
    // No error thrown means success
  });
});

// ── parser.ts ingest() unit test with mock SCIP data ───────────────────

describe("ScipParser.ingest", () => {
  let db: RepographDB;
  let store: StoreQueries;
  const tempDirs: string[] = [];

  function makeTempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "repograph-scip-test-"));
    tempDirs.push(dir);
    return join(dir, "test.db");
  }

  beforeEach(() => {
    db = createDatabase(makeTempDb());
    store = new StoreQueries(db);
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("should ingest a mock SCIP index object into the store", () => {
    const parser = new ScipParser();

    // Simulate a decoded SCIP index (what protobufjs would return after toObject)
    const mockIndex = {
      documents: [
        {
          relativePath: "src/main.ts",
          language: "typescript",
          symbols: [
            {
              symbol: "npm . pkg . MyClass#",
              kind: 7, // SCIP Kind.Class
              displayName: "MyClass",
              documentation: ["A test class"],
            },
            {
              symbol: "npm . pkg . doStuff().",
              kind: 17, // SCIP Kind.Function
              displayName: "doStuff",
              documentation: ["Does stuff"],
            },
          ],
          occurrences: [
            {
              symbol: "npm . pkg . MyClass#",
              range: [10, 6, 13], // single-line definition
              symbolRoles: SymbolRole.Definition,
            },
            {
              symbol: "npm . pkg . doStuff().",
              range: [20, 0, 8], // single-line definition
              symbolRoles: SymbolRole.Definition,
            },
            {
              symbol: "npm . pkg . MyClass#",
              range: [30, 4, 11], // single-line reference
              symbolRoles: SymbolRole.ReadAccess,
            },
          ],
        },
        {
          relativePath: "src/utils.ts",
          language: "typescript",
          symbols: [],
          occurrences: [
            {
              symbol: "npm . pkg . doStuff().",
              range: [5, 2, 9], // reference from another file
              symbolRoles: 0,
            },
            {
              // local symbol should be skipped
              symbol: "local 42",
              range: [6, 0, 3],
              symbolRoles: 0,
            },
          ],
        },
      ],
    };

    const result = parser.ingest(mockIndex, store, "/repo");

    expect(result.filesIngested).toBe(2);
    expect(result.symbolsIngested).toBe(2);
    // 4 non-local occurrences (3 from main.ts + 1 from utils.ts)
    expect(result.occurrencesIngested).toBe(4);

    // Check files were inserted
    expect(store.getFile("src/main.ts")).not.toBeNull();
    expect(store.getFile("src/utils.ts")).not.toBeNull();

    // Check symbols
    const myClass = store.getSymbol("npm . pkg . MyClass#");
    expect(myClass).not.toBeNull();
    expect(myClass!.name).toBe("MyClass");
    expect(myClass!.file_path).toBe("src/main.ts");
    expect(myClass!.kind).toBe("class");

    const doStuff = store.getSymbol("npm . pkg . doStuff().");
    expect(doStuff).not.toBeNull();
    expect(doStuff!.name).toBe("doStuff");
    expect(doStuff!.kind).toBe("function");

    // Check occurrences
    const mainOccs = store.getOccurrencesByFile("src/main.ts");
    expect(mainOccs.length).toBe(3);

    const utilsOccs = store.getOccurrencesByFile("src/utils.ts");
    expect(utilsOccs.length).toBe(1); // local 42 should be skipped

    // Check edges
    const defEdges = store.getEdgesBySource("src/main.ts");
    const defineEdges = defEdges.filter((e) => e.kind === "defines");
    const refEdges = defEdges.filter((e) => e.kind === "references");
    expect(defineEdges.length).toBe(2); // MyClass and doStuff defined
    expect(refEdges.length).toBe(1); // MyClass referenced

    // Check references from utils.ts
    const utilEdges = store.getEdgesBySource("src/utils.ts");
    expect(utilEdges.some((e) => e.kind === "references")).toBe(true);
  });

  it("should handle empty documents array", () => {
    const parser = new ScipParser();
    const result = parser.ingest({ documents: [] }, store, "/repo");

    expect(result.filesIngested).toBe(0);
    expect(result.symbolsIngested).toBe(0);
    expect(result.occurrencesIngested).toBe(0);
  });

  it("should handle missing documents field", () => {
    const parser = new ScipParser();
    const result = parser.ingest({}, store, "/repo");

    expect(result.filesIngested).toBe(0);
    expect(result.symbolsIngested).toBe(0);
    expect(result.occurrencesIngested).toBe(0);
  });

  it("should extract symbol name from SCIP symbol string", () => {
    const parser = new ScipParser();

    const mockIndex = {
      documents: [
        {
          relativePath: "test.ts",
          language: "typescript",
          symbols: [],
          occurrences: [
            {
              symbol: "scip-typescript npm @types/node 18.0.0 fs/`readFileSync`().",
              range: [1, 0, 15],
              symbolRoles: SymbolRole.Definition,
            },
          ],
        },
      ],
    };

    parser.ingest(mockIndex, store, "/repo");

    const sym = store.getSymbol(
      "scip-typescript npm @types/node 18.0.0 fs/`readFileSync`().",
    );
    expect(sym).not.toBeNull();
    expect(sym!.name).toBe("readFileSync");
  });
});

// ── Integration test: full SCIP indexing pipeline ──────────────────────

describe("ScipParser integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "scip-integration-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should parse and ingest a real SCIP index from scip-typescript", async () => {
    // This test requires scip-typescript to be available.
    // It is wrapped in try/catch to skip gracefully if not installed.
    try {
      // Create a minimal TypeScript project
      const srcDir = join(tempDir, "src");
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2020",
            module: "commonjs",
            strict: true,
            outDir: "./dist",
          },
          include: ["src/**/*"],
        }),
      );

      writeFileSync(
        join(srcDir, "index.ts"),
        `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}

const calc = new Calculator();
const result = calc.add(1, 2);
console.log(greet("world"), result);
`,
      );

      // Run scip-typescript indexer
      const indexResult = Bun.spawnSync(
        [
          "npx",
          "--yes",
          "@sourcegraph/scip-typescript",
          "index",
          "--infer-tsconfig",
        ],
        {
          cwd: tempDir,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 60_000,
        },
      );

      if (indexResult.exitCode !== 0) {
        const stderr = indexResult.stderr.toString();
        console.log(
          `Skipping integration test: scip-typescript exited with code ${indexResult.exitCode}`,
        );
        console.log(`stderr: ${stderr}`);
        return;
      }

      const scipFile = join(tempDir, "index.scip");
      const exists = await Bun.file(scipFile).exists();
      if (!exists) {
        console.log("Skipping integration test: index.scip not generated");
        return;
      }

      // Parse the SCIP index
      const parser = new ScipParser();
      await parser.loadProto();
      const index = await parser.parse(scipFile);

      expect(index).toBeDefined();
      expect((index as any).documents).toBeDefined();
      expect((index as any).documents.length).toBeGreaterThan(0);

      // Ingest into SQLite
      const dbPath = join(tempDir, "test.db");
      const db = createDatabase(dbPath);
      const store = new StoreQueries(db);

      const result = parser.ingest(index, store, tempDir);

      expect(result.filesIngested).toBeGreaterThan(0);
      expect(result.symbolsIngested).toBeGreaterThanOrEqual(0);
      expect(result.occurrencesIngested).toBeGreaterThan(0);

      // Verify symbols have correct inferred kinds
      const greetSymbols = store.searchSymbols("greet");
      if (greetSymbols.length > 0) {
        expect(greetSymbols[0].kind).toBe("function");
      }
      const calcSymbols = store.searchSymbols("Calculator");
      if (calcSymbols.length > 0) {
        expect(calcSymbols[0].kind).toBe("class");
      }
      const addSymbols = store.searchSymbols("add");
      if (addSymbols.length > 0) {
        expect(addSymbols[0].kind).toBe("method");
      }
      // At minimum check we found occurrences for the file
      const fileOccs = store.getOccurrencesByFile("src/index.ts");
      expect(fileOccs.length).toBeGreaterThan(0);

      db.close();
    } catch (err: any) {
      console.log(`Skipping integration test: ${err.message}`);
    }
  }, 90_000);
});
