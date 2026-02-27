export interface ArtifactSymbol {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

/**
 * Extract pseudo-symbols from non-code artifact files.
 * Supports .env, package.json, tsconfig.json, *.sql, openapi.yaml/json.
 */
export function extractArtifacts(
  filePath: string,
  content: string,
): ArtifactSymbol[] {
  if (filePath.endsWith(".env") || filePath.includes(".env.")) {
    return extractEnvVars(filePath, content);
  }
  if (filePath.endsWith("package.json")) {
    return extractPackageJson(filePath, content);
  }
  if (filePath.endsWith("tsconfig.json")) {
    return extractTsConfig(filePath, content);
  }
  if (filePath.endsWith(".sql")) {
    return extractSql(filePath, content);
  }
  if (
    filePath.endsWith("openapi.yaml") ||
    filePath.endsWith("openapi.yml") ||
    filePath.endsWith("openapi.json")
  ) {
    return extractOpenApi(filePath, content);
  }
  return [];
}

function extractEnvVars(filePath: string, content: string): ArtifactSymbol[] {
  const symbols: ArtifactSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) {
      symbols.push({
        id: `artifact:env:${match[1]}`,
        name: match[1],
        kind: "env_var",
        filePath,
        line: i,
      });
    }
  }
  return symbols;
}

function extractPackageJson(
  filePath: string,
  content: string,
): ArtifactSymbol[] {
  const symbols: ArtifactSymbol[] = [];
  try {
    const pkg = JSON.parse(content);
    if (pkg.scripts && typeof pkg.scripts === "object") {
      for (const name of Object.keys(pkg.scripts)) {
        symbols.push({
          id: `artifact:script:${name}`,
          name,
          kind: "config_key",
          filePath,
          line: findKeyLine(content, name),
        });
      }
    }
    // Top-level important keys
    for (const key of ["name", "version", "main", "module", "types", "bin"]) {
      if (key in pkg) {
        symbols.push({
          id: `artifact:pkg:${key}`,
          name: key,
          kind: "config_key",
          filePath,
          line: findKeyLine(content, key),
        });
      }
    }
  } catch {
    // Invalid JSON, skip
  }
  return symbols;
}

function extractTsConfig(
  filePath: string,
  content: string,
): ArtifactSymbol[] {
  const symbols: ArtifactSymbol[] = [];
  try {
    const config = JSON.parse(content);
    if (config.compilerOptions && typeof config.compilerOptions === "object") {
      for (const key of Object.keys(config.compilerOptions)) {
        symbols.push({
          id: `artifact:tsconfig:${key}`,
          name: key,
          kind: "config_key",
          filePath,
          line: findKeyLine(content, key),
        });
      }
    }
  } catch {
    // Invalid JSON, skip
  }
  return symbols;
}

function extractSql(filePath: string, content: string): ArtifactSymbol[] {
  const symbols: ArtifactSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // CREATE TABLE
    const createMatch = line.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/i,
    );
    if (createMatch) {
      symbols.push({
        id: `artifact:table:${createMatch[1]}`,
        name: createMatch[1],
        kind: "table",
        filePath,
        line: i,
      });
    }
    // ALTER TABLE
    const alterMatch = line.match(/ALTER\s+TABLE\s+["`]?(\w+)["`]?/i);
    if (alterMatch) {
      symbols.push({
        id: `artifact:table:${alterMatch[1]}`,
        name: alterMatch[1],
        kind: "table",
        filePath,
        line: i,
      });
    }
    // CREATE INDEX
    const indexMatch = line.match(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/i,
    );
    if (indexMatch) {
      symbols.push({
        id: `artifact:index:${indexMatch[1]}`,
        name: indexMatch[1],
        kind: "index",
        filePath,
        line: i,
      });
    }
  }
  return symbols;
}

function extractOpenApi(
  filePath: string,
  content: string,
): ArtifactSymbol[] {
  const symbols: ArtifactSymbol[] = [];
  try {
    // Try JSON first, then basic YAML key extraction
    let obj: any;
    if (filePath.endsWith(".json")) {
      obj = JSON.parse(content);
    } else {
      // Basic YAML parsing for paths and components/schemas
      obj = parseSimpleYaml(content);
    }

    // Extract paths
    if (obj?.paths && typeof obj.paths === "object") {
      for (const path of Object.keys(obj.paths)) {
        symbols.push({
          id: `artifact:endpoint:${path}`,
          name: path,
          kind: "api_endpoint",
          filePath,
          line: findKeyLine(content, path),
        });
      }
    }

    // Extract schemas
    const schemas = obj?.components?.schemas || obj?.definitions;
    if (schemas && typeof schemas === "object") {
      for (const name of Object.keys(schemas)) {
        symbols.push({
          id: `artifact:schema:${name}`,
          name,
          kind: "api_schema",
          filePath,
          line: findKeyLine(content, name),
        });
      }
    }
  } catch {
    // Invalid format, skip
  }
  return symbols;
}

/** Simple YAML parser that extracts top-level and nested keys. */
function parseSimpleYaml(content: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = content.split("\n");
  let currentTopKey = "";
  let currentSecondKey = "";

  for (const line of lines) {
    // Top-level key (no indentation)
    const topMatch = line.match(/^([a-zA-Z_]\w*):/);
    if (topMatch) {
      currentTopKey = topMatch[1];
      result[currentTopKey] = result[currentTopKey] || {};
      currentSecondKey = "";
      continue;
    }
    // Second-level key (2-space indent)
    const secondMatch = line.match(/^  ([a-zA-Z_/]\S*):/);
    if (secondMatch && currentTopKey) {
      currentSecondKey = secondMatch[1];
      if (typeof result[currentTopKey] !== "object") {
        result[currentTopKey] = {};
      }
      result[currentTopKey][currentSecondKey] =
        result[currentTopKey][currentSecondKey] || {};
      continue;
    }
    // Third-level key (4-space indent)
    const thirdMatch = line.match(/^    ([a-zA-Z_]\w*):/);
    if (thirdMatch && currentTopKey && currentSecondKey) {
      if (typeof result[currentTopKey][currentSecondKey] !== "object") {
        result[currentTopKey][currentSecondKey] = {};
      }
      result[currentTopKey][currentSecondKey][thirdMatch[1]] = {};
    }
  }
  return result;
}

function findKeyLine(content: string, key: string): number {
  const lines = content.split("\n");
  // Escape special regex chars in key
  const escaped = key.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  const re = new RegExp(`["']?${escaped}["']?\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return 0;
}
