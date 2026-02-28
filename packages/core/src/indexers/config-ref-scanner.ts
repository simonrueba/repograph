import type { ArtifactSymbol } from "./artifact-extractor";

export interface ConfigRefEdge {
  source: string; // source file path
  target: string; // artifact symbol id
  kind: string; // "config_ref"
  confidence: string;
}

/**
 * Scan source code for references to artifact symbols.
 * Detects process.env.KEY, os.environ["KEY"], table name strings in SQL-like code.
 */
export function scanConfigRefs(
  code: string,
  filePath: string,
  language: string,
  artifactSymbols: ArtifactSymbol[],
): ConfigRefEdge[] {
  const edges: ConfigRefEdge[] = [];
  const seen = new Set<string>();

  // Build lookup maps by kind
  const envVars = artifactSymbols.filter((s) => s.kind === "env_var");
  const tables = artifactSymbols.filter((s) => s.kind === "table");

  // Scan for env var references
  for (const envVar of envVars) {
    const patterns = [
      // TypeScript/JavaScript: process.env.KEY or process.env["KEY"] or process.env['KEY']
      new RegExp(`process\\.env\\.${escapeRegex(envVar.name)}\\b`),
      new RegExp(`process\\.env\\[["']${escapeRegex(envVar.name)}["']\\]`),
      // Python: os.environ["KEY"] or os.environ.get("KEY") or os.getenv("KEY")
      new RegExp(`os\\.environ\\[["']${escapeRegex(envVar.name)}["']\\]`),
      new RegExp(`os\\.environ\\.get\\(["']${escapeRegex(envVar.name)}["']`),
      new RegExp(`os\\.getenv\\(["']${escapeRegex(envVar.name)}["']`),
      // Vite-style: import.meta.env.KEY
      new RegExp(`import\\.meta\\.env\\.${escapeRegex(envVar.name)}\\b`),
      // Go: os.Getenv("KEY") or os.LookupEnv("KEY")
      new RegExp(`os\\.Getenv\\(["']${escapeRegex(envVar.name)}["']\\)`),
      new RegExp(`os\\.LookupEnv\\(["']${escapeRegex(envVar.name)}["']\\)`),
      // Rust: std::env::var("KEY") or env!("KEY") or env::var("KEY")
      new RegExp(`env::var\\(["']${escapeRegex(envVar.name)}["']\\)`),
      new RegExp(`env!\\(["']${escapeRegex(envVar.name)}["']\\)`),
      // Java/Scala: System.getenv("KEY") or sys.env("KEY")
      new RegExp(`System\\.getenv\\(["']${escapeRegex(envVar.name)}["']\\)`),
      new RegExp(`sys\\.env\\(["']${escapeRegex(envVar.name)}["']\\)`),
      // C#: Environment.GetEnvironmentVariable("KEY")
      new RegExp(`Environment\\.GetEnvironmentVariable\\(["']${escapeRegex(envVar.name)}["']\\)`),
      // Ruby: ENV["KEY"] or ENV['KEY'] or ENV.fetch("KEY")
      new RegExp(`ENV\\[["']${escapeRegex(envVar.name)}["']\\]`),
      new RegExp(`ENV\\.fetch\\(["']${escapeRegex(envVar.name)}["']`),
    ];

    for (const pattern of patterns) {
      if (pattern.test(code)) {
        const key = `${filePath}|${envVar.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({
            source: filePath,
            target: envVar.id,
            kind: "config_ref",
            confidence: "high",
          });
        }
        break;
      }
    }
  }

  // Scan for table name references in SQL-like strings
  for (const table of tables) {
    // Look for table name in SQL-like contexts (FROM, JOIN, INTO, UPDATE, etc.)
    const sqlPattern = new RegExp(
      `(?:FROM|JOIN|INTO|UPDATE|TABLE|DELETE\\s+FROM)\\s+["\`]?${escapeRegex(table.name)}["\`]?\\b`,
      "i",
    );
    if (sqlPattern.test(code)) {
      const key = `${filePath}|${table.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({
          source: filePath,
          target: table.id,
          kind: "config_ref",
          confidence: "approximate",
        });
      }
    }
  }

  return edges;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
