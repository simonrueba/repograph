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
  const configPath = join(repoRoot, "ariadne.boundaries.json");
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

  // Build sorted layer prefixes (longest first) for early-exit matching.
  // Sorting by descending length means the first match is always the most
  // specific, eliminating the need to scan all layers per file.
  const sortedLayers = Object.entries(config.layers)
    .map(([name, def]) => ({
      name,
      prefix: def.path.endsWith("/") ? def.path : def.path + "/",
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  // Layer lookup cache: file path → layer name (or null)
  const layerCache = new Map<string, string | null>();

  function getLayer(filePath: string): string | null {
    const cached = layerCache.get(filePath);
    if (cached !== undefined) return cached;
    for (const layer of sortedLayers) {
      if (filePath.startsWith(layer.prefix)) {
        layerCache.set(filePath, layer.name);
        return layer.name;
      }
    }
    layerCache.set(filePath, null);
    return null;
  }

  // Fetch all import edges in a single query instead of N per-file queries
  const importEdges = store.getImportEdges();
  for (const edge of importEdges) {
    const sourceLayer = getLayer(edge.source);
    if (!sourceLayer) continue;

    const targetLayer = getLayer(edge.target);
    if (!targetLayer) continue;
    if (targetLayer === sourceLayer) continue;

    const allowedImports = config.layers[sourceLayer].canImport;
    if (!allowedImports.includes(targetLayer)) {
      issues.push({
        type: "BOUNDARY_VIOLATION",
        sourceFile: edge.source,
        sourceLayer,
        targetLayer,
        importTarget: edge.target,
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}
