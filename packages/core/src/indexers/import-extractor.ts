import { dirname, join, normalize } from "path";

export interface ImportEntry {
  specifier: string;
  kind: "import" | "export";
}

// Regex patterns for TypeScript/JavaScript
const TS_IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
const TS_REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// Side-effect imports: import "./polyfill" or import "reflect-metadata"
const TS_SIDE_EFFECT_RE = /^import\s+['"]([^'"]+)['"]\s*;?\s*$/gm;
// Dynamic imports: import("./module") or await import("./module")
const TS_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Regex patterns for Python
const PY_IMPORT_RE = /^import\s+([\w.]+)/gm;
const PY_FROM_IMPORT_RE = /^from\s+([\w.]+)\s+import/gm;
// Python relative imports: from . import X, from .. import Y
const PY_REL_IMPORT_RE = /^from\s+(\.+\w*)\s+import/gm;

export function extractImports(
  code: string,
  language: string,
): ImportEntry[] {
  const imports: ImportEntry[] = [];

  if (language === "typescript" || language === "javascript") {
    const seen = new Set<string>();
    for (const match of code.matchAll(TS_IMPORT_RE)) {
      const kind = match[0].trimStart().startsWith("export")
        ? "export"
        : "import";
      imports.push({ specifier: match[1], kind });
      seen.add(match[1]);
    }
    for (const match of code.matchAll(TS_REQUIRE_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
      seen.add(match[1]);
    }
    // Side-effect imports (import "./polyfill") — skip if already caught by TS_IMPORT_RE
    for (const match of code.matchAll(TS_SIDE_EFFECT_RE)) {
      if (!seen.has(match[1])) {
        imports.push({ specifier: match[1], kind: "import" });
      }
    }
    // Dynamic imports (import("./module"))
    for (const match of code.matchAll(TS_DYNAMIC_IMPORT_RE)) {
      if (!seen.has(match[1])) {
        imports.push({ specifier: match[1], kind: "import" });
      }
    }
  } else if (language === "python") {
    for (const match of code.matchAll(PY_IMPORT_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
    for (const match of code.matchAll(PY_FROM_IMPORT_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
    // Relative imports (from . import X, from .. import Y)
    for (const match of code.matchAll(PY_REL_IMPORT_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
  }

  return imports;
}

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const TS_INDEX_SUFFIXES = TS_EXTENSIONS.map((ext) => `/index${ext}`);

export function resolveModulePath(
  specifier: string,
  fromFile: string,
  language: string,
  knownFiles?: Set<string>,
): string {
  if (language === "typescript" || language === "javascript") {
    if (specifier.startsWith(".")) {
      const dir = dirname(fromFile);
      const resolved = normalize(join(dir, specifier));

      // If knownFiles provided, try to resolve to an actual file with extension
      if (knownFiles && !knownFiles.has(resolved)) {
        for (const ext of TS_EXTENSIONS) {
          if (knownFiles.has(resolved + ext)) return resolved + ext;
        }
        for (const suffix of TS_INDEX_SUFFIXES) {
          if (knownFiles.has(resolved + suffix)) return resolved + suffix;
        }
      }

      return resolved;
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
