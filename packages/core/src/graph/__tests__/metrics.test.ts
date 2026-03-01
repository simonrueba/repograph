import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type AriadneDB } from "../../store/db";
import { StoreQueries } from "../../store/queries";
import { StructuralMetrics, type MetricsSnapshot } from "../metrics";

describe("StructuralMetrics", () => {
  let db: AriadneDB;
  let store: StoreQueries;
  let metrics: StructuralMetrics;
  const tempDirs: string[] = [];

  function makeTempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "ariadne-metrics-test-"));
    tempDirs.push(dir);
    return join(dir, "test.db");
  }

  /**
   * Seed a small project graph:
   *
   *   a.ts → b.ts → c.ts → a.ts  (cycle: a, b, c)
   *   d.ts → b.ts                 (d depends on b, no cycle)
   *   e.ts → f.ts                 (separate pair, no cycle)
   */
  function seedCyclicGraph(): void {
    for (const f of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]) {
      store.upsertFile({ path: `src/${f}`, language: "typescript", hash: `h_${f}` });
    }

    store.insertEdge({ source: "src/a.ts", target: "src/b.ts", kind: "imports" });
    store.insertEdge({ source: "src/b.ts", target: "src/c.ts", kind: "imports" });
    store.insertEdge({ source: "src/c.ts", target: "src/a.ts", kind: "imports" });
    store.insertEdge({ source: "src/d.ts", target: "src/b.ts", kind: "imports" });
    store.insertEdge({ source: "src/e.ts", target: "src/f.ts", kind: "imports" });
  }

  beforeEach(() => {
    db = createDatabase(makeTempDb());
    store = new StoreQueries(db);
    metrics = new StructuralMetrics(store, "/repo");
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  // ── Cycle detection ─────────────────────────────────────────────

  describe("detectCycles", () => {
    it("should detect a 3-node cycle", () => {
      seedCyclicGraph();
      const result = metrics.detectCycles();

      expect(result.hasCycles).toBe(true);
      expect(result.totalCycles).toBe(1);
      expect(result.largestCycleSize).toBe(3);
      expect(result.cycles[0].members).toEqual(
        expect.arrayContaining(["src/a.ts", "src/b.ts", "src/c.ts"]),
      );
    });

    it("should not report non-cyclic edges as cycles", () => {
      seedCyclicGraph();
      const result = metrics.detectCycles();

      // d→b and e→f are not cycles
      for (const cycle of result.cycles) {
        expect(cycle.members).not.toContain("src/d.ts");
        expect(cycle.members).not.toContain("src/e.ts");
        expect(cycle.members).not.toContain("src/f.ts");
      }
    });

    it("should return no cycles for acyclic graph", () => {
      store.upsertFile({ path: "src/x.ts", language: "typescript", hash: "hx" });
      store.upsertFile({ path: "src/y.ts", language: "typescript", hash: "hy" });
      store.insertEdge({ source: "src/x.ts", target: "src/y.ts", kind: "imports" });

      const result = metrics.detectCycles();
      expect(result.hasCycles).toBe(false);
      expect(result.totalCycles).toBe(0);
      expect(result.cycles).toHaveLength(0);
    });

    it("should return no cycles for empty graph", () => {
      const result = metrics.detectCycles();
      expect(result.hasCycles).toBe(false);
      expect(result.totalCycles).toBe(0);
    });

    it("should detect multiple independent cycles", () => {
      // Cycle 1: a → b → a
      store.insertEdge({ source: "src/a.ts", target: "src/b.ts", kind: "imports" });
      store.insertEdge({ source: "src/b.ts", target: "src/a.ts", kind: "imports" });
      // Cycle 2: c → d → c
      store.insertEdge({ source: "src/c.ts", target: "src/d.ts", kind: "imports" });
      store.insertEdge({ source: "src/d.ts", target: "src/c.ts", kind: "imports" });

      const result = metrics.detectCycles();
      expect(result.hasCycles).toBe(true);
      expect(result.totalCycles).toBe(2);
    });

    it("should scope cycles to path prefix", () => {
      seedCyclicGraph();
      // Only look at src/e.ts and src/f.ts scope (no cycles)
      const result = metrics.detectCycles("src/e");
      expect(result.hasCycles).toBe(false);
    });
  });

  // ── Coupling ─────────────────────────────────────────────────────

  describe("computeCoupling", () => {
    it("should compute afferent and efferent coupling", () => {
      seedCyclicGraph();
      const coupling = metrics.computeCoupling();

      // b.ts is imported by a.ts and d.ts → Ca=2, Ce=1 (b imports c)
      const bMetric = coupling.find((c) => c.module === "src/b.ts");
      expect(bMetric).toBeDefined();
      expect(bMetric!.Ca).toBe(2);
      expect(bMetric!.Ce).toBe(1);
    });

    it("should compute instability correctly", () => {
      store.insertEdge({ source: "src/a.ts", target: "src/b.ts", kind: "imports" });
      store.insertEdge({ source: "src/a.ts", target: "src/c.ts", kind: "imports" });

      const coupling = metrics.computeCoupling();
      const aMetric = coupling.find((c) => c.module === "src/a.ts");
      expect(aMetric).toBeDefined();
      // a.ts: Ca=0, Ce=2 → I = 2/(0+2) = 1.0
      expect(aMetric!.I).toBe(1);
    });

    it("should return empty for no edges", () => {
      const coupling = metrics.computeCoupling();
      expect(coupling).toHaveLength(0);
    });

    it("should scope coupling to path prefix", () => {
      seedCyclicGraph();
      const coupling = metrics.computeCoupling("src/e");
      // Only src/e.ts → src/f.ts edge in scope
      const modules = coupling.map((c) => c.module);
      expect(modules).toContain("src/e.ts");
    });
  });

  // ── API Surface ──────────────────────────────────────────────────

  describe("computeApiSurface", () => {
    it("should count exports per project", () => {
      store.upsertProject({
        project_id: "pkg-a",
        root: "packages/a",
        language: "typescript",
        last_index_ts: Date.now(),
      });

      store.insertEdge({ source: "packages/a/src/index.ts", target: "sym:foo", kind: "exports" });
      store.insertEdge({ source: "packages/a/src/index.ts", target: "sym:bar", kind: "exports" });

      const surface = metrics.computeApiSurface();
      const pkgA = surface.find((s) => s.packageId === "pkg-a");
      expect(pkgA).toBeDefined();
      expect(pkgA!.exportedSymbolCount).toBe(2);
    });

    it("should return empty for no exports", () => {
      const surface = metrics.computeApiSurface();
      expect(surface).toHaveLength(0);
    });
  });

  // ── Snapshot roundtrip ───────────────────────────────────────────

  describe("snapshot", () => {
    it("should save and load a snapshot", () => {
      seedCyclicGraph();
      const snapshot = metrics.computeMetrics();
      metrics.saveSnapshot(snapshot);

      const loaded = metrics.loadSnapshot();
      expect(loaded).not.toBeNull();
      expect(loaded!.totalFiles).toBe(snapshot.totalFiles);
      expect(loaded!.cycles.totalCycles).toBe(snapshot.cycles.totalCycles);
      expect(loaded!.coupling.length).toBe(snapshot.coupling.length);
    });

    it("should return null when no snapshot saved", () => {
      const loaded = metrics.loadSnapshot();
      expect(loaded).toBeNull();
    });
  });

  // ── Diff ─────────────────────────────────────────────────────────

  describe("diff", () => {
    it("should detect new cycles", () => {
      const previous: MetricsSnapshot = {
        timestamp: 1000,
        coupling: [],
        cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
        apiSurface: [],
        totalFiles: 0,
        totalSymbols: 0,
      };

      const current: MetricsSnapshot = {
        timestamp: 2000,
        coupling: [],
        cycles: {
          cycles: [{ members: ["a.ts", "b.ts"], size: 2 }],
          totalCycles: 1,
          largestCycleSize: 2,
          hasCycles: true,
        },
        apiSurface: [],
        totalFiles: 0,
        totalSymbols: 0,
      };

      const d = metrics.diff(current, previous);
      expect(d.newCycles).toHaveLength(1);
      expect(d.removedCycles).toHaveLength(0);
    });

    it("should detect removed cycles", () => {
      const previous: MetricsSnapshot = {
        timestamp: 1000,
        coupling: [],
        cycles: {
          cycles: [{ members: ["a.ts", "b.ts"], size: 2 }],
          totalCycles: 1,
          largestCycleSize: 2,
          hasCycles: true,
        },
        apiSurface: [],
        totalFiles: 0,
        totalSymbols: 0,
      };

      const current: MetricsSnapshot = {
        timestamp: 2000,
        coupling: [],
        cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
        apiSurface: [],
        totalFiles: 0,
        totalSymbols: 0,
      };

      const d = metrics.diff(current, previous);
      expect(d.newCycles).toHaveLength(0);
      expect(d.removedCycles).toHaveLength(1);
    });

    it("should detect API surface growth", () => {
      const previous: MetricsSnapshot = {
        timestamp: 1000,
        coupling: [],
        cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
        apiSurface: [{ packageId: "pkg-a", exportedSymbolCount: 5 }],
        totalFiles: 0,
        totalSymbols: 0,
      };

      const current: MetricsSnapshot = {
        timestamp: 2000,
        coupling: [],
        cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
        apiSurface: [{ packageId: "pkg-a", exportedSymbolCount: 8 }],
        totalFiles: 0,
        totalSymbols: 0,
      };

      const d = metrics.diff(current, previous);
      expect(d.apiGrowth).toHaveLength(1);
      expect(d.apiGrowth[0].growth).toBe(3);
    });

    it("should detect coupling increases", () => {
      const previous: MetricsSnapshot = {
        timestamp: 1000,
        coupling: [{ module: "a.ts", Ca: 1, Ce: 2, I: 0.667 }],
        cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
        apiSurface: [],
        totalFiles: 0,
        totalSymbols: 0,
      };

      const current: MetricsSnapshot = {
        timestamp: 2000,
        coupling: [{ module: "a.ts", Ca: 3, Ce: 2, I: 0.4 }],
        cycles: { cycles: [], totalCycles: 0, largestCycleSize: 0, hasCycles: false },
        apiSurface: [],
        totalFiles: 0,
        totalSymbols: 0,
      };

      const d = metrics.diff(current, previous);
      expect(d.couplingIncreases.length).toBeGreaterThan(0);
      expect(d.couplingIncreases.some((c) => c.module === "a.ts" && c.metric === "Ca")).toBe(true);
    });
  });

  // ── computeMetrics ───────────────────────────────────────────────

  describe("computeMetrics", () => {
    it("should return all metrics in one call", () => {
      seedCyclicGraph();
      const snapshot = metrics.computeMetrics();

      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.totalFiles).toBe(6);
      expect(snapshot.coupling.length).toBeGreaterThan(0);
      expect(snapshot.cycles.hasCycles).toBe(true);
    });
  });
});
