import { StructuralMetrics } from "ariadne-core";
import { getContext } from "../lib/context";
import { output, outputError } from "../lib/output";

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

export async function runMetrics(args: string[]): Promise<void> {
  const rootArg = extractFlag(args, "--root");
  const doSnapshot = hasFlag(args, "--snapshot");
  const doDiff = hasFlag(args, "--diff");

  const ctx = getContext(rootArg);
  try {
    const metrics = new StructuralMetrics(ctx.store, ctx.repoRoot);

    if (doDiff) {
      const baseline = metrics.loadSnapshot();
      if (!baseline) {
        outputError(
          "NO_BASELINE",
          "No baseline snapshot found. Run 'ariadne metrics --snapshot' first.",
        );
      }
      const current = metrics.computeMetrics();
      const diff = metrics.diff(current, baseline);
      output("metrics_diff", { current, baseline, diff });
      return;
    }

    const snapshot = metrics.computeMetrics();

    if (doSnapshot) {
      metrics.saveSnapshot(snapshot);
      output("metrics_snapshot_saved", snapshot);
      return;
    }

    output("metrics", snapshot);
  } finally {
    ctx.db.close();
  }
}
