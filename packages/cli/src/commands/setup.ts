import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, copyFileSync, chmodSync } from "fs";
import { join, resolve } from "path";
import { createDatabase } from "repograph-core";
import { output } from "../lib/output";
import { runIndex } from "./index-cmd";

/**
 * One-command setup for any project: init + index + generate configs.
 *
 * Usage:
 *   repograph setup [path]           # init + structural + SCIP index
 *   repograph setup [path] --quick   # init + structural imports only (skip SCIP)
 */
export async function runSetup(args: string[]): Promise<void> {
  const quick = args.includes("--quick");
  const rootArg = args.find((a) => !a.startsWith("--"));
  const repoRoot = resolve(rootArg || process.cwd());
  const repographDir = join(repoRoot, ".repograph");

  const steps: { step: string; status: string }[] = [];

  // Step 1: Init (idempotent — safe to re-run)
  mkdirSync(repographDir, { recursive: true });
  mkdirSync(join(repographDir, "cache", "scip"), { recursive: true });

  const dbPath = join(repographDir, "index.db");
  const db = createDatabase(dbPath);
  db.close();

  if (!existsSync(join(repographDir, "state.json"))) {
    writeFileSync(
      join(repographDir, "state.json"),
      JSON.stringify({ version: 1, createdAt: new Date().toISOString(), repoRoot }, null, 2),
    );
  }
  steps.push({ step: "init", status: "ok" });

  // Step 2: Add .repograph/ to .gitignore
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
  steps.push({ step: "gitignore", status: "ok" });

  // Step 3: Copy portable hook scripts into .repograph/hooks/
  const hooksDir = join(repographDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const srcHooksDir = join(import.meta.dir, "..", "hooks");
  for (const hookFile of ["post-edit.sh", "post-test.sh", "stop-verify.sh"]) {
    const src = join(srcHooksDir, hookFile);
    const dest = join(hooksDir, hookFile);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      chmodSync(dest, 0o755);
    }
  }
  steps.push({ step: "hooks_copied", status: "ok" });

  // Step 4: Generate .claude/settings.json for hooks (if not present)
  const claudeDir = join(repoRoot, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) {
    mkdirSync(claudeDir, { recursive: true });
    const hooksConfig = generateHooksConfig();
    writeFileSync(settingsPath, JSON.stringify(hooksConfig, null, 2) + "\n");
    steps.push({ step: "hooks_config", status: "created" });
  } else {
    steps.push({ step: "hooks_config", status: "exists" });
  }

  // Step 5: Generate .mcp.json for MCP server (if not present)
  const mcpPath = join(repoRoot, ".mcp.json");
  if (!existsSync(mcpPath)) {
    const mcpConfig = generateMcpConfig();
    writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    steps.push({ step: "mcp_config", status: "created" });
  } else {
    steps.push({ step: "mcp_config", status: "exists" });
  }

  // Step 6: Run index
  if (quick) {
    // Quick mode: structural imports only, skip SCIP indexers
    await runIndex([repoRoot, "--structural-only"]);
    steps.push({ step: "index", status: "structural" });
  } else {
    // Full mode: structural + SCIP
    await runIndex([repoRoot]);
    steps.push({ step: "index", status: "full" });
  }

  output("setup", { repoRoot, steps });
}

/**
 * Hooks config that references portable scripts in .repograph/hooks/.
 * These scripts resolve the repograph binary dynamically at runtime.
 */
function generateHooksConfig(): object {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            {
              type: "command",
              command: "bash .repograph/hooks/post-edit.sh",
            },
          ],
        },
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "bash .repograph/hooks/post-test.sh",
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "bash .repograph/hooks/stop-verify.sh",
            },
          ],
        },
      ],
    },
  };
}

function generateMcpConfig(): object {
  // Resolve the MCP server source relative to this CLI package.
  const localMcp = join(import.meta.dir, "..", "..", "..", "mcp", "src", "index.ts");

  if (!existsSync(localMcp)) {
    throw new Error(
      `Cannot find MCP server at ${localMcp}. ` +
      `Ensure you are running setup from a repograph clone.`,
    );
  }

  return {
    mcpServers: {
      repograph: {
        command: "bun",
        args: ["run", resolve(localMcp)],
        env: { REPOGRAPH_ROOT: "." },
      },
    },
  };
}
