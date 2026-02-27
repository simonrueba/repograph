import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(__dirname, "..", "..", "cli", "src", "index.ts");
const MCP_SERVER = join(__dirname, "..", "src", "index.ts");

// ── JSON-RPC helpers ────────────────────────────────────────────────

let msgId = 0;

function jsonrpc(method: string, params: Record<string, unknown> = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id: ++msgId, method, params });
}

/**
 * Send a JSON-RPC request to the MCP server and wait for the response.
 * The server communicates via newline-delimited JSON over stdio.
 */
function sendRequest(
  proc: ChildProcess,
  method: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const currentId = msgId + 1;
    const msg = jsonrpc(method, params);

    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for response to ${method} (id=${currentId})`));
    }, 15_000);

    const onData = (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === currentId) {
            clearTimeout(timeout);
            proc.stdout!.off("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          // Not JSON — skip (could be stderr leaking)
        }
      }
    };

    proc.stdout!.on("data", onData);
    proc.stdin!.write(msg + "\n");
  });
}

// ── Test suite ──────────────────────────────────────────────────────

describe("MCP Server e2e", () => {
  let testDir: string;
  let serverProc: ChildProcess;

  beforeAll(async () => {
    // 1. Create a temp project with source files
    testDir = mkdtempSync(join(tmpdir(), "repograph-mcp-test-"));

    writeFileSync(
      join(testDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
        },
        include: ["src"],
      }),
    );

    mkdirSync(join(testDir, "src"));

    writeFileSync(
      join(testDir, "src", "math.ts"),
      `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`,
    );

    writeFileSync(
      join(testDir, "src", "main.ts"),
      `import { add, multiply } from "./math";

export function calculate(a: number, b: number): number {
  return add(a, b) + multiply(a, b);
}
`,
    );

    writeFileSync(
      join(testDir, "src", "utils.ts"),
      `export const VERSION = "1.0.0";
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`,
    );

    // 2. Init + full index via CLI (index registers files + runs SCIP for symbols)
    execSync(`bun run ${CLI} init ${testDir}`, {
      cwd: testDir,
      timeout: 15_000,
      encoding: "utf-8",
    });
    execSync(`bun run ${CLI} index ${testDir}`, {
      cwd: testDir,
      timeout: 30_000,
      encoding: "utf-8",
    });

    // 3. Spawn MCP server pointing at test dir
    serverProc = spawn("bun", ["run", MCP_SERVER], {
      env: { ...process.env, REPOGRAPH_ROOT: testDir },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 1000));

    // 4. Initialize the MCP session
    const initResponse = await sendRequest(serverProc, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(initResponse.result).toBeDefined();
    expect(initResponse.result.serverInfo.name).toBe("repograph");

    // Send initialized notification (no response expected)
    serverProc.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 200));
  }, 30_000);

  afterAll(() => {
    if (serverProc) {
      serverProc.kill("SIGTERM");
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── Tool listing ──────────────────────────────────────────────────

  it("should list all 9 tools", async () => {
    const response = await sendRequest(serverProc, "tools/list");
    const tools = response.result.tools;

    expect(tools).toHaveLength(9);
    const names = tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "repograph.call_graph",
      "repograph.file_symbols",
      "repograph.find_refs",
      "repograph.get_def",
      "repograph.impact",
      "repograph.module_graph",
      "repograph.search_symbol",
      "repograph.status",
      "repograph.symbol_graph",
    ]);
  });

  it("should have readOnlyHint on all tools", async () => {
    const response = await sendRequest(serverProc, "tools/list");
    const tools = response.result.tools;

    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  it("should have titles on all tools", async () => {
    const response = await sendRequest(serverProc, "tools/list");
    const tools = response.result.tools;

    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
    }
  });

  // ── repograph.status ──────────────────────────────────────────────

  it("status should return file and symbol counts", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.status",
      arguments: {},
    });

    expect(response.result).toBeDefined();
    const data = JSON.parse(response.result.content[0].text);
    expect(data.totalFiles).toBeGreaterThanOrEqual(3);
    expect(data.totalSymbols).toBeTypeOf("number");
    expect(data.dirtyCount).toBeTypeOf("number");
    expect(data.lastIndexed).toBeTypeOf("number");
  });

  // ── repograph.search_symbol ───────────────────────────────────────

  it("search_symbol should return valid array", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.search_symbol",
      arguments: { query: "add" },
    });

    const data = JSON.parse(response.result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
    // If scip-typescript is installed, "add" should match. Otherwise empty.
    // Either way the response shape must be an array.
  });

  it("search_symbol should respect k limit", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.search_symbol",
      arguments: { query: "a", k: 2 },
    });

    const data = JSON.parse(response.result.content[0].text);
    expect(data.length).toBeLessThanOrEqual(2);
  });

  it("search_symbol should return empty array for no matches", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.search_symbol",
      arguments: { query: "zzz_nonexistent_zzz" },
    });

    const data = JSON.parse(response.result.content[0].text);
    expect(data).toEqual([]);
  });

  // ── repograph.module_graph ────────────────────────────────────────

  it("module_graph should return nodes and edges", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.module_graph",
      arguments: {},
    });

    const data = JSON.parse(response.result.content[0].text);
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
    expect(data.nodes.length).toBeGreaterThanOrEqual(2);
    // main.ts imports math.ts — should have at least one edge
    expect(data.edges.length).toBeGreaterThanOrEqual(1);
  });

  it("module_graph should scope to path prefix", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.module_graph",
      arguments: { path: "src/" },
    });

    const data = JSON.parse(response.result.content[0].text);
    // All nodes should be under src/
    for (const node of data.nodes) {
      expect(node.path.startsWith("src/")).toBe(true);
    }
  });

  it("module_graph should return DOT format", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.module_graph",
      arguments: { format: "dot" },
    });

    const text = response.result.content[0].text;
    expect(text).toContain("digraph");
    expect(text).toContain("->");
  });

  it("module_graph should return Mermaid format", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.module_graph",
      arguments: { format: "mermaid" },
    });

    const text = response.result.content[0].text;
    expect(text).toContain("graph");
    expect(text).toContain("-->");
  });

  // ── repograph.impact ──────────────────────────────────────────────

  it("impact should compute blast radius for a file", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.impact",
      arguments: { paths: ["src/math.ts"] },
    });

    const data = JSON.parse(response.result.content[0].text);
    expect(data).toBeDefined();
    expect(data.changedSymbols).toBeDefined();
    expect(data.dependentFiles).toBeDefined();
    expect(data.recommendedTests).toBeDefined();
    expect(Array.isArray(data.changedSymbols)).toBe(true);
    expect(Array.isArray(data.dependentFiles)).toBe(true);
  });

  it("impact should handle nonexistent file gracefully", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.impact",
      arguments: { paths: ["does/not/exist.ts"] },
    });

    // Should not be an error — just empty impact
    expect(response.result).toBeDefined();
    expect(response.result.isError).toBeUndefined();
  });

  // ── repograph.file_symbols ────────────────────────────────────────

  it("file_symbols should return empty array for non-indexed file", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.file_symbols",
      arguments: { path: "nonexistent.ts" },
    });

    const data = JSON.parse(response.result.content[0].text);
    expect(data).toEqual([]);
  });

  // ── repograph.get_def ─────────────────────────────────────────────

  it("get_def should return null for unknown symbol", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.get_def",
      arguments: { symbolId: "nonexistent#symbol" },
    });

    const data = JSON.parse(response.result.content[0].text);
    expect(data).toBeNull();
  });

  // ── repograph.find_refs ───────────────────────────────────────────

  it("find_refs should return empty for unknown symbol", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.find_refs",
      arguments: { symbolId: "nonexistent#symbol" },
    });

    const data = JSON.parse(response.result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  // ── repograph.symbol_graph ────────────────────────────────────────

  it("symbol_graph should return empty graph for unknown symbol", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.symbol_graph",
      arguments: { symbolId: "nonexistent#symbol" },
    });

    const data = JSON.parse(response.result.content[0].text);
    expect(data.nodes).toEqual([]);
    expect(data.edges).toEqual([]);
  });

  // ── Error handling ────────────────────────────────────────────────

  it("should return error for unknown tool", async () => {
    const response = await sendRequest(serverProc, "tools/call", {
      name: "repograph.nonexistent",
      arguments: {},
    });

    // MCP SDK returns either a top-level error or isError in the result
    const hasError =
      response.error !== undefined ||
      response.result?.isError === true;
    expect(hasError).toBe(true);
  });
});
