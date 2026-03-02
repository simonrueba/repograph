import type { StoreQueries } from "../store/queries";
import { GraphQueries } from "./refs";
import { ImpactAnalyzer } from "./impact";
import { ContextCompiler, type ContextFileEntry } from "./context";
import { isTestFile } from "./utils";

// ── Types ────────────────────────────────────────────────────────────

export type ScopeTier = "must-have" | "should-have" | "nice-to-have";

export interface ScopeSymbol {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  isExported: boolean;
  signature?: string;
  doc?: string;
}

export interface ScopeFileEntry {
  path: string;
  tier: ScopeTier;
  depth: number;
  reason: string;
  symbols: ScopeSymbol[];
  content: string;
  tokenEstimate: number;
}

export interface ScopeResult {
  files: ScopeFileEntry[];
  seedSymbols: ScopeSymbol[];
  riskScore: number;
  riskCategory: string;
  totalTokens: number;
  truncated: boolean;
  summary: string;
}

export interface ScopeOptions {
  /** Token budget for the entire context. Default 50000. */
  budget?: number;
  /** Max BFS depth for transitive context. Default 3. */
  depth?: number;
  /** Include test files in the scope. Default true. */
  includeTests?: boolean;
  /** Task description — used for future intent-based ranking. */
  taskDescription?: string;
}

// ── ScopeAnalyzer ────────────────────────────────────────────────────

export class ScopeAnalyzer {
  private store: StoreQueries;
  private repoRoot: string;
  private graph: GraphQueries;
  private impact: ImpactAnalyzer;
  private context: ContextCompiler;

  constructor(store: StoreQueries, repoRoot: string) {
    this.store = store;
    this.repoRoot = repoRoot;
    this.graph = new GraphQueries(store, repoRoot);
    this.impact = new ImpactAnalyzer(store, repoRoot);
    this.context = new ContextCompiler(store, repoRoot);
  }

  /**
   * Compute a ranked, token-budgeted context scope for an agent task.
   *
   * Returns three tiers:
   * - **must-have**: changed files + their exported symbols with full content
   * - **should-have**: depth-1 dependents with relevant symbols, full content
   * - **nice-to-have**: transitive context, signatures only if budget tight
   */
  scope(changedFiles: string[], opts?: ScopeOptions): ScopeResult {
    const budget = opts?.budget ?? 50_000;
    const maxDepth = opts?.depth ?? 3;
    const includeTests = opts?.includeTests ?? true;

    // 1. Run transitive impact to get risk-aware BFS + metadata
    const impactResult = this.impact.computeTransitiveImpact(changedFiles, {
      maxDepth,
    });

    // 2. Run ContextCompiler for token-budgeted file content
    const contextResult = this.context.compile(changedFiles, {
      depth: maxDepth,
      budget,
      includeTests,
    });

    // 3. Build seed symbols from changed files (the "must understand" set)
    const seedSymbols: ScopeSymbol[] = [];
    for (const sym of impactResult.changedSymbols) {
      const def = this.graph.getDef(sym.id);
      seedSymbols.push({
        id: sym.id,
        name: sym.name,
        kind: def?.kind ?? "unknown",
        filePath: sym.filePath,
        isExported: sym.isPublicApi,
        signature: def?.snippet?.split("\n")[0],
        doc: def?.doc,
      });
    }

    // 4. Build a lookup from ContextCompiler results
    const contextMap = new Map<string, ContextFileEntry>();
    for (const f of contextResult.files) {
      contextMap.set(f.path, f);
    }

    // 5. Build depth map from impact result
    const depthMap = new Map<string, { depth: number; reason: string }>();
    for (const af of impactResult.affectedFiles) {
      depthMap.set(af.path, { depth: af.depth, reason: af.reason });
    }

    // 6. Assign tiers and build output
    const changedSet = new Set(changedFiles);
    const files: ScopeFileEntry[] = [];
    let totalTokens = 0;

    // Process files from ContextCompiler (already priority-sorted and budget-fitted)
    for (const cf of contextResult.files) {
      const isChanged = changedSet.has(cf.path);
      const depthInfo = depthMap.get(cf.path);
      const depth = depthInfo?.depth ?? cf.depth;

      let tier: ScopeTier;
      if (isChanged || depth === 0) {
        tier = "must-have";
      } else if (depth === 1) {
        tier = "should-have";
      } else {
        tier = "nice-to-have";
      }

      // Skip test files if not requested
      if (!includeTests && isTestFile(cf.path)) continue;

      // Enrich symbols with more detail for must-have and should-have tiers
      const symbols: ScopeSymbol[] = [];
      if (tier === "must-have" || tier === "should-have") {
        const fileSymbols = this.store.getSymbolsByFile(cf.path);
        for (const sym of fileSymbols) {
          if (!sym.kind) continue;
          const def = tier === "must-have" ? this.graph.getDef(sym.id) : null;
          symbols.push({
            id: sym.id,
            name: sym.name,
            kind: sym.kind ?? "unknown",
            filePath: cf.path,
            isExported: cf.symbols.some((s) => s.name === sym.name && s.isExported),
            signature: def?.snippet?.split("\n")[0],
            doc: def?.doc,
          });
        }
      } else {
        // nice-to-have: lightweight symbol list from ContextCompiler
        for (const s of cf.symbols) {
          symbols.push({
            id: "",
            name: s.name,
            kind: s.kind,
            filePath: cf.path,
            isExported: s.isExported,
          });
        }
      }

      files.push({
        path: cf.path,
        tier,
        depth,
        reason: depthInfo?.reason ?? cf.reason,
        symbols,
        content: cf.content,
        tokenEstimate: cf.tokenEstimate,
      });
      totalTokens += cf.tokenEstimate;
    }

    // Sort: must-have first, then should-have, then nice-to-have
    const tierOrder: Record<ScopeTier, number> = { "must-have": 0, "should-have": 1, "nice-to-have": 2 };
    files.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.depth - b.depth);

    const tierCounts = { "must-have": 0, "should-have": 0, "nice-to-have": 0 };
    for (const f of files) tierCounts[f.tier]++;

    return {
      files,
      seedSymbols,
      riskScore: impactResult.riskScore,
      riskCategory: impactResult.riskCategory,
      totalTokens,
      truncated: contextResult.truncated,
      summary: `${files.length} files (${tierCounts["must-have"]} must-have, ${tierCounts["should-have"]} should-have, ${tierCounts["nice-to-have"]} nice-to-have), ${totalTokens} tokens, risk ${impactResult.riskScore} ${impactResult.riskCategory}`,
    };
  }
}
