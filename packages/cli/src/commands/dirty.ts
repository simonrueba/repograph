import { getContext } from "../lib/context";
import { output, outputError } from "../lib/output";

export function runDirty(args: string[]): void {
  const subcommand = args[0];
  // For "mark", args are: mark <path> [--root <dir>]
  // For "list"/"clear", args are: list|clear [--root <dir>]
  const rootFlag = args.indexOf("--root");
  const rootArg = rootFlag !== -1 ? args[rootFlag + 1] : undefined;

  switch (subcommand) {
    case "mark": {
      const path = args[1];
      if (!path || path.startsWith("--")) {
        outputError("MISSING_PATH", "Usage: ariadne dirty mark <file-path>");
      }
      const ctx = getContext(rootArg);
      ctx.store.markDirty(path);
      ctx.db.close();
      output("dirty-mark", { path });
      break;
    }
    case "list": {
      const ctx = getContext(rootArg);
      const paths = ctx.store.getDirtyPaths();
      ctx.db.close();
      output("dirty-list", { count: paths.length, paths });
      break;
    }
    case "count": {
      const ctx = getContext(rootArg);
      const count = ctx.store.getDirtyCount();
      ctx.db.close();
      // Raw number on stdout — designed for shell scripting (e.g. bg index trigger)
      process.stdout.write(String(count));
      break;
    }
    case "clear": {
      const ctx = getContext(rootArg);
      ctx.store.clearAllDirty();
      ctx.db.close();
      output("dirty-clear", { cleared: true });
      break;
    }
    default:
      outputError(
        "UNKNOWN_SUBCOMMAND",
        `Unknown dirty subcommand: ${subcommand}. Usage: ariadne dirty <mark|list|count|clear>`,
      );
  }
}
