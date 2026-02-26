import { writeFileSync } from "fs";
import { join } from "path";
import { VerifyEngine } from "repograph-core";
import { getContext } from "../lib/context";
import { output } from "../lib/output";

export async function runVerify(args: string[]): Promise<void> {
  const rootArg = args.find((a) => !a.startsWith("--"));
  const ctx = getContext(rootArg);
  const engine = new VerifyEngine(ctx.store, ctx.ledger, ctx.repoRoot);
  const report = engine.verify();

  // Always write verify_last.json (atomic write via temp file)
  const reportPath = join(ctx.repographDir, "verify_last.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  ctx.db.close();

  output("verify", report);

  if (report.status !== "OK") {
    process.exit(1);
  }
}
