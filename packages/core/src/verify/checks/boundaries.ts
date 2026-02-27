import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { StoreQueries } from "../../store/queries";

export interface BoundaryConfig {
  layers: Record<string, { path: string; canImport: string[] }>;
}

export interface BoundaryIssue {
  type: "BOUNDARY_VIOLATION";
  sourceFile: string;
  sourceLayer: string;
  targetLayer: string;
  importTarget: string;
}

export interface BoundaryCheckResult {
  passed: boolean;
  issues: BoundaryIssue[];
}

export function checkBoundaries(
  store: StoreQueries,
  repoRoot: string,
): BoundaryCheckResult {
  const configPath = join(repoRoot, "repograph.boundaries.json");
  if (!existsSync(configPath)) {
    return { passed: true, issues: [] };
  }

  let config: BoundaryConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { passed: true, issues: [] };
  }

  if (!config.layers || Object.keys(config.layers).length === 0) {
    return { passed: true, issues: [] };
  }

  const issues: BoundaryIssue[] = [];

  // Build a mapping from path prefix to layer name
  const layerEntries = Object.entries(config.layers);

  // Find which layer a file belongs to
  function getLayer(filePath: string): string | null {
    let bestMatch: string | null = null;
    let bestLen = 0;
    for (const [name, def] of layerEntries) {
      const prefix = def.path.endsWith("/") ? def.path : def.path + "/";
      if (filePath.startsWith(prefix) && prefix.length > bestLen) {
        bestMatch = name;
        bestLen = prefix.length;
      }
    }
    return bestMatch;
  }

  // Check all "imports" edges
  const allFiles = store.getAllFiles();
  for (const file of allFiles) {
    const sourceLayer = getLayer(file.path);
    if (!sourceLayer) continue;

    const edges = store.getEdgesBySource(file.path);
    for (const edge of edges) {
      if (edge.kind !== "imports") continue;

      const targetLayer = getLayer(edge.target);
      if (!targetLayer) continue;
      if (targetLayer === sourceLayer) continue;

      const allowedImports = config.layers[sourceLayer].canImport;
      if (!allowedImports.includes(targetLayer)) {
        issues.push({
          type: "BOUNDARY_VIOLATION",
          sourceFile: file.path,
          sourceLayer,
          targetLayer,
          importTarget: edge.target,
        });
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}
