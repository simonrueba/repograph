import { getContext } from "../lib/context";
import { output } from "../lib/output";

export async function runStatus(args: string[]): Promise<void> {
  const ctx = getContext(args[0]);

  const totalFiles = (
    ctx.db
      .query("SELECT COUNT(*) as count FROM files")
      .get() as { count: number }
  ).count;

  const totalSymbols = (
    ctx.db
      .query("SELECT COUNT(*) as count FROM symbols")
      .get() as { count: number }
  ).count;

  const totalEdges = (
    ctx.db
      .query("SELECT COUNT(*) as count FROM edges")
      .get() as { count: number }
  ).count;

  const meta = {
    schemaVersion: ctx.store.getMeta("schema_version"),
    lastStructuralIndexTs: ctx.store.getMeta("last_structural_index_ts"),
    lastFullScipIndexTs: ctx.store.getMeta("last_full_scip_index_ts"),
  };

  ctx.db.close();

  output("status", { totalFiles, totalSymbols, totalEdges, meta });
}
