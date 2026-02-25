import { VerifyEngine } from "repograph-core";
import { getContext } from "../lib/context";

export async function runVerify(args: string[]): Promise<void> {
  const ctx = getContext(args[0]);
  const engine = new VerifyEngine(ctx.store, ctx.ledger, ctx.repoRoot);
  const report = engine.verify();

  ctx.db.close();

  console.log(JSON.stringify(report));

  if (report.status === "OK") {
    console.error("REPOGRAPH_VERIFY: OK");
    process.exit(0);
  } else {
    console.error("REPOGRAPH_VERIFY: FAIL");
    process.exit(1);
  }
}
