import { createDatabase, StoreQueries, Ledger } from "repograph-core";
import { existsSync } from "fs";
import { join } from "path";

export interface CliContext {
  repoRoot: string;
  repographDir: string;
  db: ReturnType<typeof createDatabase>;
  store: StoreQueries;
  ledger: Ledger;
}

export function getContext(repoRoot?: string): CliContext {
  const root = repoRoot || process.cwd();
  const repographDir = join(root, ".repograph");
  if (!existsSync(repographDir)) {
    throw new Error(`.repograph/ not found. Run 'repograph init' first.`);
  }
  const db = createDatabase(join(repographDir, "index.db"));
  return {
    repoRoot: root,
    repographDir,
    db,
    store: new StoreQueries(db),
    ledger: new Ledger(db),
  };
}
