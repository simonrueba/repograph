import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type AriadneDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { StructuralMetrics } from "../../graph/metrics";
import { checkPolicies } from "../checks/policies";

describe("checkPolicies", () => {
  let db: AriadneDB;
  let store: StoreQueries;
  let repoRoot: string;
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-policies-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function writePolicy(config: unknown): void {
    writeFileSync(
      join(repoRoot, "ariadne.policies.json"),
      JSON.stringify(config),
    );
  }

  beforeEach(() => {
    repoRoot = makeTempDir();
    // Put DB inside repoRoot so paths are consistent
    db = createDatabase(join(repoRoot, "test.db"));
    store = new StoreQueries(db);
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("should pass when no config file exists", () => {
    const result = checkPolicies(store, repoRoot);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("should pass when config is malformed", () => {
    writeFileSync(join(repoRoot, "ariadne.policies.json"), "not json");
    const result = checkPolicies(store, repoRoot);
    expect(result.passed).toBe(true);
  });

  it("should pass when no policies defined", () => {
    writePolicy({});
    const result = checkPolicies(store, repoRoot);
    expect(result.passed).toBe(true);
  });

  it("should pass when no baseline snapshot exists", () => {
    writePolicy({ policies: { deny_new_cycles: true } });
    const result = checkPolicies(store, repoRoot);
    expect(result.passed).toBe(true);
  });

  it("should detect new cycles when deny_new_cycles is true", () => {
    writePolicy({ policies: { deny_new_cycles: true } });

    // Save a baseline with no cycles
    const metrics = new StructuralMetrics(store, repoRoot);
    metrics.saveSnapshot({
      timestamp: 1000,
      coupling: [],
      cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
      apiSurface: [],
      totalFiles: 0,
      totalSymbols: 0,
    });

    // Now create a cycle in the graph
    store.insertEdge({ source: "a.ts", target: "b.ts", kind: "imports" });
    store.insertEdge({ source: "b.ts", target: "a.ts", kind: "imports" });

    const result = checkPolicies(store, repoRoot);
    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].policy).toBe("deny_new_cycles");
  });

  it("should pass when deny_new_cycles is true but no new cycles", () => {
    writePolicy({ policies: { deny_new_cycles: true } });

    // Save a baseline that already has the cycle
    store.insertEdge({ source: "a.ts", target: "b.ts", kind: "imports" });
    store.insertEdge({ source: "b.ts", target: "a.ts", kind: "imports" });

    const metrics = new StructuralMetrics(store, repoRoot);
    const snapshot = metrics.computeMetrics();
    metrics.saveSnapshot(snapshot);

    // No new cycles added — should pass
    const result = checkPolicies(store, repoRoot);
    expect(result.passed).toBe(true);
  });

  it("should detect API growth exceeding limit", () => {
    writePolicy({ policies: { max_public_api_growth: 2 } });

    // Save baseline with 3 exports
    store.upsertProject({ project_id: "pkg-a", root: "pkg", language: "typescript", last_index_ts: Date.now() });

    const metrics = new StructuralMetrics(store, repoRoot);
    metrics.saveSnapshot({
      timestamp: 1000,
      coupling: [],
      cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
      apiSurface: [{ packageId: "pkg-a", exportedSymbolCount: 3 }],
      totalFiles: 0,
      totalSymbols: 0,
    });

    // Add 5 more exports (growth = 5, exceeds max 2)
    for (let i = 0; i < 8; i++) {
      store.insertEdge({ source: `pkg/src/file${i}.ts`, target: `sym:export${i}`, kind: "exports" });
    }

    const result = checkPolicies(store, repoRoot);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.policy === "max_public_api_growth")).toBe(true);
  });

  it("should pass when API growth is within limit", () => {
    writePolicy({ policies: { max_public_api_growth: 10 } });

    store.upsertProject({ project_id: "pkg-a", root: "pkg", language: "typescript", last_index_ts: Date.now() });

    const metrics = new StructuralMetrics(store, repoRoot);
    metrics.saveSnapshot({
      timestamp: 1000,
      coupling: [],
      cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
      apiSurface: [{ packageId: "pkg-a", exportedSymbolCount: 5 }],
      totalFiles: 0,
      totalSymbols: 0,
    });

    // Add 3 more (growth = 3, within limit of 10) — total 8 but we need to match project
    for (let i = 0; i < 8; i++) {
      store.insertEdge({ source: `pkg/src/file${i}.ts`, target: `sym:exp${i}`, kind: "exports" });
    }

    const result = checkPolicies(store, repoRoot);
    expect(result.passed).toBe(true);
  });

  it("should detect coupling increases exceeding limit", () => {
    writePolicy({ policies: { max_coupling_increase: 1 } });

    const metrics = new StructuralMetrics(store, repoRoot);
    metrics.saveSnapshot({
      timestamp: 1000,
      coupling: [{ module: "a.ts", Ca: 1, Ce: 1, I: 0.5 }],
      cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
      apiSurface: [],
      totalFiles: 0,
      totalSymbols: 0,
    });

    // Create edges that give a.ts Ca=5 (increase of 4, exceeds max 1)
    store.insertEdge({ source: "b.ts", target: "a.ts", kind: "imports" });
    store.insertEdge({ source: "c.ts", target: "a.ts", kind: "imports" });
    store.insertEdge({ source: "d.ts", target: "a.ts", kind: "imports" });
    store.insertEdge({ source: "e.ts", target: "a.ts", kind: "imports" });
    store.insertEdge({ source: "f.ts", target: "a.ts", kind: "imports" });
    store.insertEdge({ source: "a.ts", target: "g.ts", kind: "imports" });

    const result = checkPolicies(store, repoRoot);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.policy === "max_coupling_increase")).toBe(true);
  });

  it("should report multiple policy violations", () => {
    writePolicy({
      policies: {
        deny_new_cycles: true,
        max_coupling_increase: 0,
      },
    });

    const metrics = new StructuralMetrics(store, repoRoot);
    metrics.saveSnapshot({
      timestamp: 1000,
      coupling: [{ module: "a.ts", Ca: 0, Ce: 0, I: 0 }],
      cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
      apiSurface: [],
      totalFiles: 0,
      totalSymbols: 0,
    });

    // Create a cycle AND increase coupling
    store.insertEdge({ source: "a.ts", target: "b.ts", kind: "imports" });
    store.insertEdge({ source: "b.ts", target: "a.ts", kind: "imports" });

    const result = checkPolicies(store, repoRoot);
    expect(result.passed).toBe(false);
    const policies = result.issues.map((i) => i.policy);
    expect(policies).toContain("deny_new_cycles");
    expect(policies).toContain("max_coupling_increase");
  });
});
