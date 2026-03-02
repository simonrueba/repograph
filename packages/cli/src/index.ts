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
    case "dirty": {
      const { runDirty } = await import("./commands/dirty");
      await runDirty(args.slice(1));
      break;
    }
    case "setup": {
      const { runSetup } = await import("./commands/setup");
      await runSetup(args.slice(1));
      break;
    }
    case "doctor": {
      const { runDoctor } = await import("./commands/doctor");
      runDoctor(args.slice(1));
      break;
    }
    case "post-edit": {
      const { runPostEdit } = await import("./commands/post-edit");
      runPostEdit(args.slice(1));
      break;
    }
    case "impact": {
      const { runImpact } = await import("./commands/impact");
      await runImpact(args.slice(1));
      break;
    }
    case "metrics": {
      const { runMetrics } = await import("./commands/metrics");
      await runMetrics(args.slice(1));
      break;
    }
    case "ci": {
      const { runCi } = await import("./commands/ci");
      await runCi(args.slice(1));
      break;
    }
    case "context": {
      const { runContext } = await import("./commands/context");
      await runContext(args.slice(1));
      break;
    }
    case "preflight": {
      const { runPreflight } = await import("./commands/preflight");
      await runPreflight(args.slice(1));
      break;
    }
    case "scope": {
      const { runScope } = await import("./commands/scope");
      runScope(args.slice(1));
      break;
    }
    default: {
      const { outputError } = await import("./lib/output");
      outputError(
        "UNKNOWN_COMMAND",
        `Unknown command: ${command}. Usage: ariadne <setup|init|index|update|query|verify|ledger|status|dirty|doctor|post-edit|impact|metrics|ci|context|preflight|scope>`,
      );
    }
  }
}

main().catch((e) => {
  console.log(
    JSON.stringify({
      ok: false,
      kind: "error",
      error: { code: "INTERNAL_ERROR", message: e.message },
    }),
  );
  process.exit(1);
});
