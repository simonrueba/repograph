import { getContext } from "../lib/context";

export async function runLedger(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "log": {
      const event = args[1];
      const jsonStr = args[2];
      if (!event || !jsonStr) {
        console.error("Usage: repograph ledger log <event> '<json>'");
        process.exit(1);
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        console.error(`Invalid JSON: ${jsonStr}`);
        process.exit(1);
      }

      const rootArg = args.find((a, i) => i > 2 && !a.startsWith("--"));
      const ctx = getContext(rootArg);
      ctx.ledger.log(event, data);
      ctx.db.close();

      console.log(JSON.stringify({ status: "logged", event, data }));
      break;
    }

    case "list": {
      const rootArg = args.find((a, i) => i > 0 && !a.startsWith("--"));
      const ctx = getContext(rootArg);
      const entries = ctx.ledger.getAll();
      ctx.db.close();
      console.log(JSON.stringify({ entries }));
      break;
    }

    default:
      console.error(`Unknown ledger subcommand: ${subcommand}`);
      console.error("Usage: repograph ledger <log|list>");
      process.exit(1);
  }
}
