import { createDatabase, StoreQueries, Ledger } from "ariadne-core";
import { existsSync } from "fs";
import { join } from "path";

export interface CliContext {
  repoRoot: string;
  ariadneDir: string;
  db: ReturnType<typeof createDatabase>;
  store: StoreQueries;
  ledger: Ledger;
}

export function getContext(repoRoot?: string): CliContext {
  const root = repoRoot || process.cwd();
  const ariadneDir = join(root, ".ariadne");
  if (!existsSync(ariadneDir)) {
    throw new Error(`.ariadne/ not found. Run 'ariadne init' first.`);
  }
  const db = createDatabase(join(ariadneDir, "index.db"));
  return {
    repoRoot: root,
    ariadneDir,
    db,
    store: new StoreQueries(db),
    ledger: new Ledger(db),
  };
}
