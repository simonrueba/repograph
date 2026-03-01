import type { StoreQueries } from "../store/queries";

// ── Result types ──────────────────────────────────────────────────────

export interface CouplingMetric {
  module: string;
  /** Afferent coupling: number of modules that depend on this module. */
  Ca: number;
  /** Efferent coupling: number of modules this module depends on. */
  Ce: number;
  /** Instability: Ce / (Ca + Ce). 0 = fully stable, 1 = fully unstable. */
  I: number;
}

export interface CycleInfo {
  members: string[];
  size: number;
}

export interface CycleResult {
  cycles: CycleInfo[];
  totalCycles: number;
  largestCycleSize: number;
  hasCycles: boolean;
}

export interface PackageApiSurface {
  packageId: string;
  exportedSymbolCount: number;
}

export interface MetricsSnapshot {
  timestamp: number;
  coupling: CouplingMetric[];
  cycles: CycleResult;
  apiSurface: PackageApiSurface[];
  totalFiles: number;
  totalSymbols: number;
}

export interface MetricsDelta {
  module: string;
  metric: string;
  previous: number;
  current: number;
  change: number;
}

export interface MetricsDiff {
  deltas: MetricsDelta[];
  newCycles: CycleInfo[];
  removedCycles: CycleInfo[];
  apiGrowth: { packageId: string; growth: number }[];
  couplingIncreases: { module: string; metric: string; increase: number }[];
}

// ── Meta key for snapshot persistence ──────────────────────────────────

const SNAPSHOT_META_KEY = "metrics_snapshot";

// ── StructuralMetrics ──────────────────────────────────────────────────

export class StructuralMetrics {
  constructor(
    private store: StoreQueries,
    private repoRoot: string,
  ) {}

  /**
   * Detect dependency cycles using Tarjan's SCC algorithm (iterative).
   *
   * Builds an adjacency list from import edges, runs iterative Tarjan's,
   * and returns SCCs with size > 1 (those are cycles).
   */
  detectCycles(scopePath?: string): CycleResult {
    const importEdges = this.store.getImportEdges();

    // Build adjacency list from import edges
    const adj = new Map<string, string[]>();
    const allNodes = new Set<string>();

    for (const edge of importEdges) {
      if (scopePath && !edge.source.startsWith(scopePath)) continue;

      allNodes.add(edge.source);
      allNodes.add(edge.target);
      const neighbors = adj.get(edge.source);
      if (neighbors) {
        neighbors.push(edge.target);
      } else {
        adj.set(edge.source, [edge.target]);
      }
    }

    // Iterative Tarjan's SCC
    const sccs = tarjanIterative(allNodes, adj);

    // Filter to cycles (SCC size > 1)
    const cycles: CycleInfo[] = sccs
      .filter((scc) => scc.length > 1)
      .map((members) => ({ members: members.sort(), size: members.length }));

    return {
      cycles,
      totalCycles: cycles.length,
      largestCycleSize: cycles.reduce((max, c) => Math.max(max, c.size), 0),
      hasCycles: cycles.length > 0,
    };
  }

  /**
   * Compute afferent/efferent coupling and instability per module.
   *
   * A "module" is a file that appears in import edges.
   * Ca = number of distinct files that import this module.
   * Ce = number of distinct files this module imports.
   * I  = Ce / (Ca + Ce), or 0 if both are 0.
   */
  computeCoupling(scopePath?: string): CouplingMetric[] {
    const importEdges = this.store.getImportEdges();

    // Ca: who depends on me (target → set of sources)
    const afferent = new Map<string, Set<string>>();
    // Ce: who do I depend on (source → set of targets)
    const efferent = new Map<string, Set<string>>();
    const allModules = new Set<string>();

    for (const edge of importEdges) {
      if (scopePath && !edge.source.startsWith(scopePath)) continue;

      allModules.add(edge.source);
      allModules.add(edge.target);

      // efferent: source imports target
      let ce = efferent.get(edge.source);
      if (!ce) {
        ce = new Set();
        efferent.set(edge.source, ce);
      }
      ce.add(edge.target);

      // afferent: target is imported by source
      let ca = afferent.get(edge.target);
      if (!ca) {
        ca = new Set();
        afferent.set(edge.target, ca);
      }
      ca.add(edge.source);
    }

    const result: CouplingMetric[] = [];
    for (const mod of allModules) {
      const Ca = afferent.get(mod)?.size ?? 0;
      const Ce = efferent.get(mod)?.size ?? 0;
      const I = Ca + Ce > 0 ? Ce / (Ca + Ce) : 0;
      result.push({
        module: mod,
        Ca,
        Ce,
        I: Math.round(I * 1000) / 1000,
      });
    }

    return result.sort((a, b) => a.module.localeCompare(b.module));
  }

  /**
   * Compute the public API surface per project (package).
   *
   * Counts export edges per project root — each export edge represents
   * a symbol being re-exported from a package entry point.
   */
  computeApiSurface(): PackageApiSurface[] {
    const exportEdges = this.store.getExportEdges();
    const projects = this.store.getAllProjects();

    // Sort projects by root length descending for longest-prefix match
    const sortedProjects = [...projects].sort(
      (a, b) => b.root.length - a.root.length,
    );

    const counts = new Map<string, number>();

    for (const edge of exportEdges) {
      // Find the project this export belongs to (longest prefix match)
      const project = sortedProjects.find(
        (p) => edge.source.startsWith(p.root + "/") || edge.source === p.root,
      );
      const projectId = project?.project_id ?? "unknown";
      counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([packageId, exportedSymbolCount]) => ({ packageId, exportedSymbolCount }))
      .sort((a, b) => a.packageId.localeCompare(b.packageId));
  }

  /**
   * Compute all metrics in one call.
   */
  computeMetrics(scopePath?: string): MetricsSnapshot {
    return {
      timestamp: Date.now(),
      coupling: this.computeCoupling(scopePath),
      cycles: this.detectCycles(scopePath),
      apiSurface: this.computeApiSurface(),
      totalFiles: this.store.getFileCount(),
      totalSymbols: this.store.getSymbolCount(),
    };
  }

  /**
   * Save a metrics snapshot to the meta table.
   */
  saveSnapshot(snapshot: MetricsSnapshot): void {
    this.store.setMeta(SNAPSHOT_META_KEY, JSON.stringify(snapshot));
  }

  /**
   * Load the previously saved metrics snapshot, or null if none exists.
   */
  loadSnapshot(): MetricsSnapshot | null {
    const raw = this.store.getMeta(SNAPSHOT_META_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MetricsSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Compare two snapshots and produce a diff.
   */
  diff(current: MetricsSnapshot, previous: MetricsSnapshot): MetricsDiff {
    const deltas: MetricsDelta[] = [];
    const couplingIncreases: MetricsDiff["couplingIncreases"] = [];

    // Build lookup maps for coupling by module
    const prevCoupling = new Map(previous.coupling.map((c) => [c.module, c]));
    const currCoupling = new Map(current.coupling.map((c) => [c.module, c]));

    // Track coupling changes
    for (const [mod, curr] of currCoupling) {
      const prev = prevCoupling.get(mod);
      if (prev) {
        if (curr.Ca !== prev.Ca) {
          deltas.push({ module: mod, metric: "Ca", previous: prev.Ca, current: curr.Ca, change: curr.Ca - prev.Ca });
          if (curr.Ca > prev.Ca) couplingIncreases.push({ module: mod, metric: "Ca", increase: curr.Ca - prev.Ca });
        }
        if (curr.Ce !== prev.Ce) {
          deltas.push({ module: mod, metric: "Ce", previous: prev.Ce, current: curr.Ce, change: curr.Ce - prev.Ce });
          if (curr.Ce > prev.Ce) couplingIncreases.push({ module: mod, metric: "Ce", increase: curr.Ce - prev.Ce });
        }
        if (curr.I !== prev.I) {
          deltas.push({ module: mod, metric: "I", previous: prev.I, current: curr.I, change: Math.round((curr.I - prev.I) * 1000) / 1000 });
          if (curr.I > prev.I) couplingIncreases.push({ module: mod, metric: "I", increase: Math.round((curr.I - prev.I) * 1000) / 1000 });
        }
      }
    }

    // Cycle diff: compare cycle member sets
    const prevCycleKeys = new Set(
      previous.cycles.cycles.map((c) => c.members.join("\0")),
    );
    const currCycleKeys = new Set(
      current.cycles.cycles.map((c) => c.members.join("\0")),
    );

    const newCycles = current.cycles.cycles.filter(
      (c) => !prevCycleKeys.has(c.members.join("\0")),
    );
    const removedCycles = previous.cycles.cycles.filter(
      (c) => !currCycleKeys.has(c.members.join("\0")),
    );

    // API surface growth
    const prevApi = new Map(
      previous.apiSurface.map((a) => [a.packageId, a.exportedSymbolCount]),
    );
    const apiGrowth: MetricsDiff["apiGrowth"] = [];
    for (const curr of current.apiSurface) {
      const prevCount = prevApi.get(curr.packageId) ?? 0;
      const growth = curr.exportedSymbolCount - prevCount;
      if (growth !== 0) {
        apiGrowth.push({ packageId: curr.packageId, growth });
      }
    }

    return { deltas, newCycles, removedCycles, apiGrowth, couplingIncreases };
  }
}

// ── Tarjan's SCC (iterative) ───────────────────────────────────────────

/**
 * Iterative Tarjan's Strongly Connected Components algorithm.
 *
 * Uses an explicit call stack to avoid recursion depth issues on large graphs.
 * Returns all SCCs (including singletons). Caller filters to size > 1 for cycles.
 */
function tarjanIterative(
  nodes: Set<string>,
  adj: Map<string, string[]>,
): string[][] {
  let indexCounter = 0;
  const nodeIndex = new Map<string, number>();
  const nodeLowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  // Explicit call stack for iterative DFS.
  // Each frame tracks: node, neighbor index, lowlink
  interface Frame {
    node: string;
    neighborIdx: number;
  }

  for (const node of nodes) {
    if (nodeIndex.has(node)) continue;

    // Start DFS from this node
    const callStack: Frame[] = [{ node, neighborIdx: 0 }];
    nodeIndex.set(node, indexCounter);
    nodeLowlink.set(node, indexCounter);
    indexCounter++;
    onStack.add(node);
    stack.push(node);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const neighbors = adj.get(frame.node) ?? [];

      if (frame.neighborIdx < neighbors.length) {
        const neighbor = neighbors[frame.neighborIdx];
        frame.neighborIdx++;

        if (!nodeIndex.has(neighbor)) {
          // Tree edge: push new frame
          nodeIndex.set(neighbor, indexCounter);
          nodeLowlink.set(neighbor, indexCounter);
          indexCounter++;
          onStack.add(neighbor);
          stack.push(neighbor);
          callStack.push({ node: neighbor, neighborIdx: 0 });
        } else if (onStack.has(neighbor)) {
          // Back edge: update lowlink
          nodeLowlink.set(
            frame.node,
            Math.min(nodeLowlink.get(frame.node)!, nodeIndex.get(neighbor)!),
          );
        }
      } else {
        // All neighbors visited — pop frame
        callStack.pop();

        if (callStack.length > 0) {
          // Update parent's lowlink
          const parent = callStack[callStack.length - 1];
          nodeLowlink.set(
            parent.node,
            Math.min(nodeLowlink.get(parent.node)!, nodeLowlink.get(frame.node)!),
          );
        }

        // Check if this node is a root of an SCC
        if (nodeLowlink.get(frame.node) === nodeIndex.get(frame.node)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== frame.node);
          sccs.push(scc);
        }
      }
    }
  }

  return sccs;
}
