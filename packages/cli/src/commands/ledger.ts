import { getContext } from "../lib/context";
import { output, outputError } from "../lib/output";

export async function runLedger(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "log": {
      const event = args[1];
      const jsonStr = args[2];
      if (!event || !jsonStr) {
        outputError("MISSING_ARGUMENT", "Usage: repograph ledger log <event> '<json>'");
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        outputError("INVALID_JSON", `Invalid JSON: ${jsonStr}`);
      }

      const rootArg = args.find((a, i) => i > 2 && !a.startsWith("--"));
      const ctx = getContext(rootArg);
      ctx.ledger.log(event, data);
      ctx.db.close();

      output("ledger.log", { event, data });
      break;
    }

    case "list": {
      const rootArg = args.find((a, i) => i > 0 && !a.startsWith("--"));
      const ctx = getContext(rootArg);
      const entries = ctx.ledger.getAll();
      ctx.db.close();
      output("ledger.list", { entries });
      break;
    }

    default:
      outputError(
        "UNKNOWN_SUBCOMMAND",
        `Unknown ledger subcommand: ${subcommand}`,
      );
  }
}
