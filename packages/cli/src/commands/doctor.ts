import { execSync } from "child_process";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { detectProjects } from "ariadne-core";
import { output } from "../lib/output";

interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

interface DoctorData {
  checks: DoctorCheck[];
  allOk: boolean;
}

/** Run a shell command and return trimmed stdout, or null on failure. */
function runCommand(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Parse a semver-like version string and return [major, minor, patch]. */
function parseSemver(raw: string): [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function checkBunVersion(): DoctorCheck {
  const raw = runCommand("bun --version");
  if (!raw) {
    return { name: "bun_version", status: "fail", detail: "bun not found on PATH" };
  }
  const parsed = parseSemver(raw);
  if (!parsed) {
    return { name: "bun_version", status: "warn", detail: `could not parse version: ${raw}` };
  }
  const [major] = parsed;
  if (major < 1) {
    return {
      name: "bun_version",
      status: "fail",
      detail: `${raw} — requires >= 1.0.0`,
    };
  }
  return { name: "bun_version", status: "ok", detail: raw };
}

function checkNodeVersion(): DoctorCheck {
  const raw = runCommand("node --version");
  if (!raw) {
    return { name: "node_version", status: "warn", detail: "node not found on PATH (informational only)" };
  }
  return { name: "node_version", status: "ok", detail: raw.replace(/^v/, "") };
}

function checkScipTypescript(): DoctorCheck {
  // Indexer runs: npx --yes @sourcegraph/scip-typescript index
  const raw = runCommand("npx --yes @sourcegraph/scip-typescript --version");
  if (!raw) {
    return {
      name: "scip_typescript",
      status: "warn",
      detail: "@sourcegraph/scip-typescript not available via npx — TypeScript SCIP indexing will be skipped",
    };
  }
  return { name: "scip_typescript", status: "ok", detail: raw };
}

function checkScipPython(): DoctorCheck {
  // Indexer runs: uvx scip-python index
  const raw = runCommand("uvx scip-python --version") ?? runCommand("scip-python --version");
  if (!raw) {
    return {
      name: "scip_python",
      status: "warn",
      detail: "scip-python not available via uvx or PATH — Python SCIP indexing will be skipped",
    };
  }
  return { name: "scip_python", status: "ok", detail: raw };
}

function checkScipGo(): DoctorCheck {
  const raw = runCommand("scip-go --help");
  if (!raw) {
    return {
      name: "scip_go",
      status: "warn",
      detail: "scip-go not found on PATH — Go SCIP indexing will be skipped. Install: go install github.com/sourcegraph/scip-go@latest",
    };
  }
  return { name: "scip_go", status: "ok", detail: "available" };
}

function checkScipRust(): DoctorCheck {
  const raw = runCommand("rust-analyzer --version");
  if (!raw) {
    return {
      name: "scip_rust",
      status: "warn",
      detail: "rust-analyzer not found on PATH — Rust SCIP indexing will be skipped. Install: rustup component add rust-analyzer",
    };
  }
  return { name: "scip_rust", status: "ok", detail: raw };
}

function checkScipJava(): DoctorCheck {
  const raw = runCommand("scip-java --help") ?? runCommand("mvn --version");
  if (!raw) {
    return {
      name: "scip_java",
      status: "warn",
      detail: "scip-java not found on PATH — Java SCIP indexing will be skipped. Install: coursier install scip-java",
    };
  }
  return { name: "scip_java", status: "ok", detail: "available" };
}

function checkScipCsharp(): DoctorCheck {
  const raw = runCommand("scip-dotnet --help") ?? runCommand("dotnet --version");
  if (!raw) {
    return {
      name: "scip_csharp",
      status: "warn",
      detail: "scip-dotnet not found on PATH — C# SCIP indexing will be skipped. Install: dotnet tool install --global scip-dotnet",
    };
  }
  return { name: "scip_csharp", status: "ok", detail: "available" };
}

function checkScipRuby(): DoctorCheck {
  const raw = runCommand("scip-ruby --help");
  if (!raw) {
    return {
      name: "scip_ruby",
      status: "warn",
      detail: "scip-ruby not found on PATH — Ruby SCIP indexing will be skipped. Install: gem install scip-ruby",
    };
  }
  return { name: "scip_ruby", status: "ok", detail: "available" };
}

function checkTsconfigDetection(repoRoot: string): DoctorCheck {
  try {
    const projects = detectProjects(repoRoot);
    if (projects.length === 0) {
      return {
        name: "tsconfig_detection",
        status: "warn",
        detail: "no projects detected in current directory",
      };
    }
    const summary = projects
      .map((p) => `${p.projectId} (${p.language})`)
      .join(", ");
    return { name: "tsconfig_detection", status: "ok", detail: summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "tsconfig_detection", status: "warn", detail: msg };
  }
}

function checkWritePermission(repoRoot: string): DoctorCheck {
  const ariadneDir = join(repoRoot, ".ariadne");
  if (!existsSync(ariadneDir)) {
    return {
      name: "write_permission",
      status: "warn",
      detail: "not initialized — run `ariadne init` first",
    };
  }
  const probe = join(ariadneDir, ".write-probe");
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
    return { name: "write_permission", status: "ok", detail: ariadneDir };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "write_permission", status: "fail", detail: msg };
  }
}

function checkLegacyDir(repoRoot: string): DoctorCheck {
  const legacyDir = join(repoRoot, ".repograph");
  if (existsSync(legacyDir)) {
    return {
      name: "legacy_dir",
      status: "warn",
      detail: ".repograph/ directory found — this is stale from before the rename. Safe to delete: rm -rf .repograph/",
    };
  }
  return { name: "legacy_dir", status: "ok", detail: "no legacy .repograph/ directory" };
}

function checkIndexDb(repoRoot: string): DoctorCheck {
  const dbPath = join(repoRoot, ".ariadne", "index.db");
  if (!existsSync(dbPath)) {
    return {
      name: "index_db",
      status: "warn",
      detail: "index.db not found — run `ariadne init` then `ariadne index`",
    };
  }
  return { name: "index_db", status: "ok", detail: dbPath };
}

export function runDoctor(args: string[]): void {
  const repoRoot = args[0] || process.cwd();

  const checks: DoctorCheck[] = [
    checkBunVersion(),
    checkNodeVersion(),
    checkScipTypescript(),
    checkScipPython(),
    checkScipGo(),
    checkScipRust(),
    checkScipJava(),
    checkScipCsharp(),
    checkScipRuby(),
    checkTsconfigDetection(repoRoot),
    checkWritePermission(repoRoot),
    checkIndexDb(repoRoot),
    checkLegacyDir(repoRoot),
  ];

  const allOk = checks.every((c) => c.status === "ok");
  const data: DoctorData = { checks, allOk };

  output("doctor", data);

  if (!allOk) {
    process.exit(1);
  }
}
