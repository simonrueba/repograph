// ariadne-core — public API

// ── Store ────────────────────────────────────────────────────────────────
export { createDatabase } from "./store/db";
export type { AriadneDB } from "./store/db";
export { SCHEMA_SQL } from "./store/schema";
export { StoreQueries } from "./store/queries";
export type {
  FileRecord,
  SymbolRecord,
  OccurrenceRecord,
  EdgeRecord,
  ProjectRecord,
} from "./store/queries";
export { FileQueries, SymbolQueries, OccurrenceQueries, EdgeQueries, MetaQueries, DirtyQueries, ProjectQueries } from "./store/queries/index";

// ── Ledger ───────────────────────────────────────────────────────────────
export { Ledger } from "./ledger/ledger";
export type { LedgerEntry } from "./ledger/ledger";

// ── SCIP ─────────────────────────────────────────────────────────────────
export { ScipParser } from "./scip/parser";
export { SymbolRole, decodeScipRange, packRange } from "./scip/types";
export type { ScipRange } from "./scip/types";

// ── Graph ────────────────────────────────────────────────────────────────
export { GraphQueries } from "./graph/refs";
export type { SymbolResult, DefResult, RefResult, CallGraphResult } from "./graph/refs";
export { ImpactAnalyzer } from "./graph/impact";
export type { ImpactResult, DetailedImpactResult, SymbolDetail, KeyRef, TransitiveImpactResult } from "./graph/impact";
export { ModuleGraph } from "./graph/modules";
export type { ModuleGraphResult, GraphMode } from "./graph/modules";
export { StructuralMetrics } from "./graph/metrics";
export type { CouplingMetric, CycleInfo, CycleResult, PackageApiSurface, MetricsSnapshot, MetricsDiff } from "./graph/metrics";
export { ContextCompiler } from "./graph/context";
export type { ContextFileEntry, ContextResult, ContextOptions } from "./graph/context";
export { PreflightAnalyzer } from "./graph/preflight";
export type { PreflightResult, PreflightSymbol, PreflightCallSite, PreflightBlastRadius, PreflightBoundary, PreflightOptions } from "./graph/preflight";
export { computeRiskScore } from "./graph/risk";
export type { RiskInputs, RiskResult, RiskCategory, RiskBreakdown } from "./graph/risk";

// ── Verify ───────────────────────────────────────────────────────────────
export { VerifyEngine } from "./verify/engine";
export type { VerifyReport } from "./verify/engine";
export { checkBoundaries } from "./verify/checks/boundaries";
export type { BoundaryConfig, BoundaryIssue, BoundaryCheckResult } from "./verify/checks/boundaries";
export { redactReport, redactString } from "./verify/redact";
export { checkPolicies } from "./verify/checks/policies";
export type { PolicyConfig, PolicyIssue, PolicyCheckResult } from "./verify/checks/policies";

// ── Indexers ─────────────────────────────────────────────────────────────
export { extractImports, resolveModulePath } from "./indexers/import-extractor";
export type { ImportEntry } from "./indexers/import-extractor";
export { ScipTypescriptIndexer } from "./indexers/scip-typescript";
export { ScipPythonIndexer } from "./indexers/scip-python";
export { ScipGoIndexer } from "./indexers/scip-go";
export { ScipRustIndexer } from "./indexers/scip-rust";
export { ScipJavaIndexer } from "./indexers/scip-java";
export { ScipCsharpIndexer } from "./indexers/scip-csharp";
export { ScipRubyIndexer } from "./indexers/scip-ruby";
export type { Indexer, IndexResult } from "./indexers/types";
export { detectProjects } from "./indexers/project-detector";
export type { DetectedProject } from "./indexers/project-detector";

// ── Indexers: Artifacts ─────────────────────────────────────────────────
export { extractArtifacts } from "./indexers/artifact-extractor";
export type { ArtifactSymbol } from "./indexers/artifact-extractor";
export { scanConfigRefs } from "./indexers/config-ref-scanner";
export type { ConfigRefEdge } from "./indexers/config-ref-scanner";
