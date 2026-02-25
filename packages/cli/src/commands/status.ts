import { getContext } from "../lib/context";

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

  ctx.db.close();

  console.log(
    JSON.stringify({
      totalFiles,
      totalSymbols,
      totalEdges,
    }),
  );
}
