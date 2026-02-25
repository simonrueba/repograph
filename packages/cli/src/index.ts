#!/usr/bin/env bun
const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "init": {
      const { runInit } = await import("./commands/init");
      await runInit(args.slice(1));
      break;
    }
    case "index": {
      const { runIndex } = await import("./commands/index-cmd");
      await runIndex(args.slice(1));
      break;
    }
    case "update": {
      const { runUpdate } = await import("./commands/update");
      await runUpdate(args.slice(1));
      break;
    }
    case "query": {
      const { runQuery } = await import("./commands/query");
      await runQuery(args.slice(1));
      break;
    }
    case "verify": {
      const { runVerify } = await import("./commands/verify");
      await runVerify(args.slice(1));
      break;
    }
    case "ledger": {
      const { runLedger } = await import("./commands/ledger");
      await runLedger(args.slice(1));
      break;
    }
    case "status": {
      const { runStatus } = await import("./commands/status");
      await runStatus(args.slice(1));
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error(
        "Usage: repograph <init|index|update|query|verify|ledger|status>",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
