import { dirname, join, normalize } from "path";

export interface ImportEntry {
  specifier: string;
  kind: "import" | "export";
}

// Regex patterns for TypeScript/JavaScript
const TS_IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
const TS_REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Regex patterns for Python
const PY_IMPORT_RE = /^import\s+([\w.]+)/gm;
const PY_FROM_IMPORT_RE = /^from\s+([\w.]+)\s+import/gm;

export function extractImports(
  code: string,
  language: string,
): ImportEntry[] {
  const imports: ImportEntry[] = [];

  if (language === "typescript" || language === "javascript") {
    for (const match of code.matchAll(TS_IMPORT_RE)) {
      const kind = match[0].trimStart().startsWith("export")
        ? "export"
        : "import";
      imports.push({ specifier: match[1], kind });
    }
    for (const match of code.matchAll(TS_REQUIRE_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
  } else if (language === "python") {
    for (const match of code.matchAll(PY_IMPORT_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
    for (const match of code.matchAll(PY_FROM_IMPORT_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
  }

  return imports;
}

export function resolveModulePath(
  specifier: string,
  fromFile: string,
  language: string,
): string {
  if (language === "typescript" || language === "javascript") {
    if (specifier.startsWith(".")) {
      const dir = dirname(fromFile);
      return normalize(join(dir, specifier));
    }
    return specifier; // bare specifier (external package)
  }

  if (language === "python") {
    if (specifier.startsWith(".")) {
      const dir = dirname(fromFile);
      const relParts = specifier.replace(/^\.+/, "");
      const dots = specifier.length - relParts.length;
      let base = dir;
      for (let i = 1; i < dots; i++) base = dirname(base);
      return relParts
        ? normalize(join(base, relParts.replace(/\./g, "/")))
        : base;
    }
    return specifier;
  }

  return specifier;
}
