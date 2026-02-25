import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { createDatabase } from "repograph-core";

export async function runInit(args: string[]): Promise<void> {
  const repoRoot = args[0] || process.cwd();
  const repographDir = join(repoRoot, ".repograph");

  // 1. Create .repograph directory
  mkdirSync(repographDir, { recursive: true });

  // 2. Initialize SQLite DB (creates schema)
  const dbPath = join(repographDir, "index.db");
  const db = createDatabase(dbPath);
  db.close();

  // 3. Write state.json
  const stateJson = {
    version: 1,
    createdAt: new Date().toISOString(),
    repoRoot,
  };
  writeFileSync(
    join(repographDir, "state.json"),
    JSON.stringify(stateJson, null, 2),
  );

  // 4. Add .repograph/ to .gitignore if not already present
  const gitignorePath = join(repoRoot, ".gitignore");
  const gitignoreEntry = ".repograph/";
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
        command: "repograph update",
      },
      {
        event: "test_completed",
        command: "repograph ledger log test_run '{}'",
      },
    ],
  };
  writeFileSync(
    join(repographDir, "hooks.json"),
    JSON.stringify(hooksConfig, null, 2),
  );

  // 6. Write mcp.json (MCP server config)
  const mcpConfig = {
    name: "repograph",
    version: "0.1.0",
    tools: ["query", "verify", "status"],
  };
  writeFileSync(
    join(repographDir, "mcp.json"),
    JSON.stringify(mcpConfig, null, 2),
  );

  console.log(
    JSON.stringify({
      status: "initialized",
      repographDir,
      dbPath,
    }),
  );
}
