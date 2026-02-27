import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { createDatabase } from "ariadne-core";
import { output } from "../lib/output";

export async function runInit(args: string[]): Promise<void> {
  const repoRoot = args[0] || process.cwd();
  const ariadneDir = join(repoRoot, ".ariadne");

  // 1. Create .ariadne directory
  mkdirSync(ariadneDir, { recursive: true });
  mkdirSync(join(ariadneDir, "cache", "scip"), { recursive: true });

  // 2. Initialize SQLite DB (creates schema)
  const dbPath = join(ariadneDir, "index.db");
  const db = createDatabase(dbPath);
  db.close();

  // 3. Write state.json
  const stateJson = {
    version: 1,
    createdAt: new Date().toISOString(),
    repoRoot,
  };
  writeFileSync(
    join(ariadneDir, "state.json"),
    JSON.stringify(stateJson, null, 2),
  );

  // 4. Add .ariadne/ to .gitignore if not already present
  const gitignorePath = join(repoRoot, ".gitignore");
  const gitignoreEntry = ".ariadne/";
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(gitignoreEntry)) {
      appendFileSync(gitignorePath, `\n${gitignoreEntry}\n`);
    }
  } else {
    writeFileSync(gitignorePath, `${gitignoreEntry}\n`);
  }

  // 5. Write hooks.json (Claude Code hook config)
  const hooksConfig = {
    hooks: [
      {
        event: "file_edited",
        command: "ariadne update",
      },
      {
        event: "test_completed",
        command: "ariadne ledger log test_run '{}'",
      },
    ],
  };
  writeFileSync(
    join(ariadneDir, "hooks.json"),
    JSON.stringify(hooksConfig, null, 2),
  );

  // 6. Write mcp.json (MCP server config)
  const mcpConfig = {
    name: "ariadne",
    version: "0.1.0",
    tools: ["query", "verify", "status"],
  };
  writeFileSync(
    join(ariadneDir, "mcp.json"),
    JSON.stringify(mcpConfig, null, 2),
  );

  output("init", { ariadneDir, dbPath });
}
