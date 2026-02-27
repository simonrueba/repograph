import { writeFileSync } from "fs";
import { join } from "path";
import { VerifyEngine, redactReport } from "ariadne-core";
import { getContext } from "../lib/context";
import { output } from "../lib/output";

export async function runVerify(args: string[]): Promise<void> {
  const rootArg = args.find((a) => !a.startsWith("--"));
  const ctx = getContext(rootArg);
  const engine = new VerifyEngine(ctx.store, ctx.ledger, ctx.repoRoot);
  const report = await engine.verify();

  // Always write verify_last.json — redact secrets before persisting to disk
  // to prevent accidental prompt leakage if an LLM ingests the report.
  const reportPath = join(ctx.ariadneDir, "verify_last.json");
  writeFileSync(reportPath, JSON.stringify(redactReport(report), null, 2));

  ctx.db.close();

  // Redact stdout too — LLMs see stdout via hook output
  output("verify", redactReport(report));

  if (report.status !== "OK") {
    process.exit(1);
  }
}
