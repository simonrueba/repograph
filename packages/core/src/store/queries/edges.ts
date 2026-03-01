import type { AriadneDB } from "../db";
import type { EdgeRecord } from "../types";

export class EdgeQueries {
  constructor(private db: AriadneDB) {}

  insertEdge(edge: EdgeRecord): void {
    this.db
      .query(
        `INSERT INTO edges (source, target, kind, confidence)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .run(edge.source, edge.target, edge.kind, edge.confidence ?? "high");
  }

  getEdgesBySource(source: string): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE source = ?1",
      )
      .all(source) as EdgeRecord[];
  }

  getEdgesByTarget(target: string): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE target = ?1",
      )
      .all(target) as EdgeRecord[];
  }

  /**
   * Batch-fetch edges by multiple targets using a cached prepared statement.
   * Uses stmt loop instead of dynamic IN clause (avoids recompilation per unique count).
   */
  getEdgesByTargetBatch(targets: string[]): EdgeRecord[] {
    if (targets.length === 0) return [];
    const stmt = this.db.query(
      "SELECT source, target, kind, confidence FROM edges WHERE target = ?1",
    );
    const results: EdgeRecord[] = [];
    for (const t of targets) {
      const rows = stmt.all(t) as EdgeRecord[];
      results.push(...rows);
    }
    return results;
  }

  /**
   * Batch-insert edges using a single cached prepared statement.
   * Bun SQLite caches compiled statements, making stmt.run() in a loop
   * faster than multi-row INSERT (which rebuilds SQL per chunk).
   */
  insertEdges(edges: EdgeRecord[]): void {
    if (edges.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO edges (source, target, kind, confidence)
       VALUES (?1, ?2, ?3, ?4)`,
    );
    for (const edge of edges) {
      stmt.run(edge.source, edge.target, edge.kind, edge.confidence ?? "high");
    }
  }

  /** Fetch all import edges in a single query. */
  getImportEdges(): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE kind = 'imports'",
      )
      .all() as EdgeRecord[];
  }

  /** Fetch all export edges in a single query. */
  getExportEdges(): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE kind = 'exports'",
      )
      .all() as EdgeRecord[];
  }

  getCallees(symbolId: string): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE source = ?1 AND kind = 'calls'",
      )
      .all(symbolId) as EdgeRecord[];
  }

  getCallers(symbolId: string): EdgeRecord[] {
    return this.db
      .query(
        "SELECT source, target, kind, confidence FROM edges WHERE target = ?1 AND kind = 'calls'",
      )
      .all(symbolId) as EdgeRecord[];
  }

  clearEdgesForFile(source: string): void {
    this.db.query("DELETE FROM edges WHERE source = ?1").run(source);
  }

  /**
   * Clear semantic edges produced by SCIP ingestion for a specific file.
   * - Deletes `defines` and `references` edges where `source = filePath`
   * - Deletes `calls` edges originating from symbols defined in this file
   *
   * This prevents edge bloat when re-ingesting the same file multiple times.
   */
  clearSemanticEdgesForFile(filePath: string): void {
    this.db
      .query("DELETE FROM edges WHERE source = ?1 AND kind IN ('defines', 'references')")
      .run(filePath);
    this.db
      .query(
        "DELETE FROM edges WHERE kind = 'calls' AND source IN (SELECT id FROM symbols WHERE file_path = ?1)",
      )
      .run(filePath);
  }

  clearAllEdges(): void {
    this.db.exec("DELETE FROM edges");
  }
}
