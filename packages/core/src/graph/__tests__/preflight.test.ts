import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type AriadneDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { PreflightAnalyzer, type PreflightResult } from "../preflight";

describe("PreflightAnalyzer", () => {
  let db: AriadneDB;
  let queries: StoreQueries;
  let analyzer: PreflightAnalyzer;
  let repoDir: string;
  const tempDirs: string[] = [];

  function makeTempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-preflight-test-"));
    tempDirs.push(dir);
    return dir;
  }

  /**
   * Seed graph:
   *
   * src/entry.ts defines "main" (exported), "helper" (private)
   * src/utils.ts defines "formatDate" (exported)
   * src/consumer.ts references "main"
   * src/routes.ts references "main"
   * src/entry.test.ts references "main" (test file)
   *
   * Import edges:
   *   consumer.ts → imports entry
   *   routes.ts → imports entry
   *   entry.test.ts → imports entry
   *   entry.ts → imports utils
   */
  function seedGraph(): void {
    for (const f of [
      "src/entry.ts",
      "src/utils.ts",
      "src/consumer.ts",
      "src/routes.ts",
      "src/entry.test.ts",
    ]) {
      queries.upsertFile({ path: f, language: "typescript", hash: "h" });
    }

    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src/entry.ts"), "export function main() {\n  return helper();\n}\nfunction helper() { return 1; }\n");
    writeFileSync(join(repoDir, "src/utils.ts"), "export function formatDate(d: Date) {\n  return d.toISOString();\n}\n");
    writeFileSync(join(repoDir, "src/consumer.ts"), "import { main } from './entry';\nmain();\n");
    writeFileSync(join(repoDir, "src/routes.ts"), "import { main } from './entry';\napp.get('/', main);\n");
    writeFileSync(join(repoDir, "src/entry.test.ts"), "import { main } from './entry';\ntest('main', () => main());\n");

    // Symbols
    queries.upsertSymbol({ id: "sym:main", kind: "function", name: "main", file_path: "src/entry.ts", range_start: 0, range_end: 50 });
    queries.upsertSymbol({ id: "sym:helper", kind: "function", name: "helper", file_path: "src/entry.ts", range_start: (3 << 16), range_end: (3 << 16) + 30 });
    queries.upsertSymbol({ id: "sym:formatDate", kind: "function", name: "formatDate", file_path: "src/utils.ts", range_start: 0, range_end: 40 });

    // Occurrences - definitions (roles=1)
    queries.upsertOccurrence({ file_path: "src/entry.ts", range_start: 0, range_end: 50, symbol_id: "sym:main", roles: 1 });
    queries.upsertOccurrence({ file_path: "src/entry.ts", range_start: (3 << 16), range_end: (3 << 16) + 30, symbol_id: "sym:helper", roles: 1 });
    queries.upsertOccurrence({ file_path: "src/utils.ts", range_start: 0, range_end: 40, symbol_id: "sym:formatDate", roles: 1 });

    // Occurrences - references (roles=2)
    queries.upsertOccurrence({ file_path: "src/consumer.ts", range_start: (1 << 16), range_end: (1 << 16) + 4, symbol_id: "sym:main", roles: 2 });
    queries.upsertOccurrence({ file_path: "src/routes.ts", range_start: (1 << 16), range_end: (1 << 16) + 4, symbol_id: "sym:main", roles: 2 });
    queries.upsertOccurrence({ file_path: "src/entry.test.ts", range_start: (1 << 16), range_end: (1 << 16) + 4, symbol_id: "sym:main", roles: 2 });

    // Import edges
    queries.insertEdge({ source: "src/consumer.ts", target: "src/entry", kind: "imports" });
    queries.insertEdge({ source: "src/routes.ts", target: "src/entry", kind: "imports" });
    queries.insertEdge({ source: "src/entry.test.ts", target: "src/entry", kind: "imports" });
    queries.insertEdge({ source: "src/entry.ts", target: "src/utils", kind: "imports" });

    // Export edges
    queries.insertEdge({ source: "src/entry.ts", target: "pkg", kind: "exports" });
    queries.insertEdge({ source: "src/utils.ts", target: "pkg", kind: "exports" });
  }

  beforeEach(() => {
    repoDir = makeTempRepo();
    db = createDatabase(join(repoDir, "test.db"));
    queries = new StoreQueries(db);
    analyzer = new PreflightAnalyzer(queries, repoDir);
    seedGraph();
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("should return all symbols defined in the file", () => {
    const result = analyzer.analyze("src/entry.ts");

    expect(result.symbols).toHaveLength(2);
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain("main");
    expect(names).toContain("helper");
  });

  it("should detect exported symbols", () => {
    const result = analyzer.analyze("src/entry.ts");

    const mainSym = result.symbols.find((s) => s.name === "main")!;
    expect(mainSym.isExported).toBe(true);
  });

  it("should extract symbol signatures", () => {
    const result = analyzer.analyze("src/entry.ts");

    const mainSym = result.symbols.find((s) => s.name === "main")!;
    expect(mainSym.signature).toContain("function main()");
  });

  it("should find call sites with correct file and line", () => {
    const result = analyzer.analyze("src/entry.ts");

    const mainSym = result.symbols.find((s) => s.name === "main")!;
    expect(mainSym.callSites.length).toBeGreaterThanOrEqual(2);

    const consumerSite = mainSym.callSites.find(
      (cs) => cs.file === "src/consumer.ts",
    );
    expect(consumerSite).toBeDefined();
    expect(consumerSite!.line).toBe(1); // line 1 (0-indexed: reference at line 1)
  });

  it("should include snippet in call sites", () => {
    const result = analyzer.analyze("src/entry.ts");

    const mainSym = result.symbols.find((s) => s.name === "main")!;
    const consumerSite = mainSym.callSites.find(
      (cs) => cs.file === "src/consumer.ts",
    );
    expect(consumerSite).toBeDefined();
    expect(consumerSite!.snippet).toBeTruthy();
  });

  it("should associate test files with symbols", () => {
    const result = analyzer.analyze("src/entry.ts");

    const mainSym = result.symbols.find((s) => s.name === "main")!;
    expect(mainSym.testFiles).toContain("src/entry.test.ts");
  });

  it("should compute blast radius with correct direct dependents", () => {
    const result = analyzer.analyze("src/entry.ts", { fast: true });

    // consumer.ts, routes.ts, entry.test.ts reference main
    expect(result.blastRadius.directDependents).toBeGreaterThanOrEqual(2);
  });

  it("should assign risk category based on direct dependents", () => {
    const result = analyzer.analyze("src/entry.ts", { fast: true });

    expect(["low", "medium", "high", "critical"]).toContain(
      result.blastRadius.riskCategory,
    );
  });

  it("should return low risk for files with few dependents", () => {
    const result = analyzer.analyze("src/utils.ts", { fast: true });

    // formatDate has no references in our seed
    expect(result.blastRadius.riskCategory).toBe("low");
  });

  it("should cap call sites to 5 in fast mode", () => {
    // Add many references to main
    for (let i = 0; i < 10; i++) {
      const path = `src/ref${i}.ts`;
      queries.upsertFile({ path, language: "typescript", hash: "h" });
      writeFileSync(join(repoDir, path), `import { main } from './entry';\nmain();\n`);
      queries.upsertOccurrence({
        file_path: path,
        range_start: (1 << 16),
        range_end: (1 << 16) + 4,
        symbol_id: "sym:main",
        roles: 2,
      });
    }

    const result = analyzer.analyze("src/entry.ts", { fast: true });

    const mainSym = result.symbols.find((s) => s.name === "main")!;
    expect(mainSym.callSites.length).toBeLessThanOrEqual(5);
  });

  it("should not cap call sites in full mode", () => {
    for (let i = 0; i < 8; i++) {
      const path = `src/ref${i}.ts`;
      queries.upsertFile({ path, language: "typescript", hash: "h" });
      writeFileSync(join(repoDir, path), `import { main } from './entry';\nmain();\n`);
      queries.upsertOccurrence({
        file_path: path,
        range_start: (1 << 16),
        range_end: (1 << 16) + 4,
        symbol_id: "sym:main",
        roles: 2,
      });
    }

    const result = analyzer.analyze("src/entry.ts", { fast: false });

    const mainSym = result.symbols.find((s) => s.name === "main")!;
    expect(mainSym.callSites.length).toBeGreaterThan(5);
  });

  it("should build prescriptive checklist for exported symbols with call sites", () => {
    const result = analyzer.analyze("src/entry.ts");

    expect(result.checklist.length).toBeGreaterThan(0);
    const changeItem = result.checklist.find((c) => c.includes("main"));
    expect(changeItem).toBeDefined();
    expect(changeItem).toContain("call site");
  });

  it("should include test file recommendations in checklist", () => {
    const result = analyzer.analyze("src/entry.ts");

    const testItem = result.checklist.find((c) => c.includes("Run tests"));
    expect(testItem).toBeDefined();
    expect(testItem).toContain("entry.test.ts");
  });

  it("should return null boundaries when no config exists", () => {
    const result = analyzer.analyze("src/entry.ts");

    expect(result.boundaries).toBeNull();
  });

  it("should populate boundary info when config exists", () => {
    writeFileSync(
      join(repoDir, "ariadne.boundaries.json"),
      JSON.stringify({
        layers: {
          core: { path: "src/", canImport: [] },
        },
      }),
    );

    const result = analyzer.analyze("src/entry.ts");

    expect(result.boundaries).not.toBeNull();
    expect(result.boundaries!.layer).toBe("core");
  });

  it("should handle empty file (no symbols)", () => {
    queries.upsertFile({ path: "src/empty.ts", language: "typescript", hash: "h" });
    writeFileSync(join(repoDir, "src/empty.ts"), "");

    const result = analyzer.analyze("src/empty.ts");

    expect(result.symbols).toHaveLength(0);
    expect(result.blastRadius.directDependents).toBe(0);
    expect(result.blastRadius.riskCategory).toBe("low");
  });

  it("should report the correct file path", () => {
    const result = analyzer.analyze("src/entry.ts");
    expect(result.file).toBe("src/entry.ts");
  });

  it("should include kind in symbol results", () => {
    const result = analyzer.analyze("src/entry.ts");

    const mainSym = result.symbols.find((s) => s.name === "main")!;
    expect(mainSym.kind).toBe("function");
  });

  it("should work in full mode with transitive impact", () => {
    const result = analyzer.analyze("src/entry.ts", { fast: false });

    expect(result.blastRadius.transitiveDependents).toBeGreaterThanOrEqual(
      result.blastRadius.directDependents,
    );
  });
});
