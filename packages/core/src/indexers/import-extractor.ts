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

// Regex patterns for Go
// Single import: import "fmt"
const GO_IMPORT_SINGLE_RE = /^import\s+(?:\w+\s+)?["']([^"']+)["']/gm;
// Block import: import ( "fmt" \n "os" )
const GO_IMPORT_BLOCK_RE = /^import\s*\(([^)]*)\)/gms;
// Individual line inside a block import
const GO_IMPORT_LINE_RE = /(?:\w+\s+)?["']([^"']+)["']/g;

// Regex patterns for Rust
// use statements: use std::io, use crate::module::Item
const RUST_USE_RE = /^use\s+([\w:]+(?:::\{[^}]+\})?(?:::\*)?)\s*;/gm;
// mod declarations: mod my_module;
const RUST_MOD_RE = /^mod\s+(\w+)\s*;/gm;
// extern crate: extern crate serde;
const RUST_EXTERN_RE = /^extern\s+crate\s+(\w+)\s*;/gm;

// Regex patterns for Java/Kotlin
// import com.example.MyClass; or import static com.example.MyClass.method;
const JAVA_IMPORT_RE = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;

// Regex patterns for Scala
// import scala.collection.mutable or import scala.collection.mutable._
// import scala.collection.mutable.{Map, Set}
// Scala imports may or may not have a trailing semicolon
const SCALA_IMPORT_RE = /^import\s+([\w.]+(?:\.\{[^}]+\}|\._|\.\*)?)\s*;?$/gm;

// Regex patterns for C#
// using System.IO; or using static System.Math; or using Alias = System.IO;
const CSHARP_USING_RE = /^using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/gm;

// Regex patterns for Ruby
// require "json" or require 'json'
const RUBY_REQUIRE_RE = /^(?:require|require_relative)\s+['"]([^'"]+)['"]/gm;
// Explicit load: load "file.rb"
const RUBY_LOAD_RE = /^load\s+['"]([^'"]+)['"]/gm;

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
  } else if (language === "go") {
    // Single-line imports: import "fmt"
    for (const match of code.matchAll(GO_IMPORT_SINGLE_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
    // Block imports: import ( "fmt" \n "os" )
    for (const blockMatch of code.matchAll(GO_IMPORT_BLOCK_RE)) {
      const block = blockMatch[1];
      for (const lineMatch of block.matchAll(GO_IMPORT_LINE_RE)) {
        imports.push({ specifier: lineMatch[1], kind: "import" });
      }
    }
  } else if (language === "rust") {
    // use statements: use std::io::Read;
    for (const match of code.matchAll(RUST_USE_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
    // mod declarations: mod my_module;
    for (const match of code.matchAll(RUST_MOD_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
    // extern crate: extern crate serde;
    for (const match of code.matchAll(RUST_EXTERN_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
  } else if (language === "java") {
    // Java/Kotlin: import com.example.MyClass;
    for (const match of code.matchAll(JAVA_IMPORT_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
  } else if (language === "scala") {
    // Scala: import scala.collection.mutable._
    for (const match of code.matchAll(SCALA_IMPORT_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
  } else if (language === "csharp") {
    // C#: using System.IO;
    for (const match of code.matchAll(CSHARP_USING_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
  } else if (language === "ruby") {
    // Ruby: require "json" or require_relative "lib/helper"
    for (const match of code.matchAll(RUBY_REQUIRE_RE)) {
      imports.push({ specifier: match[1], kind: "import" });
    }
    // load "file.rb"
    for (const match of code.matchAll(RUBY_LOAD_RE)) {
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

  if (language === "go") {
    // Go imports are always package paths (e.g. "fmt", "github.com/user/pkg")
    // No relative path resolution needed — return as-is
    return specifier;
  }

  if (language === "rust") {
    // Rust use paths: crate::module::Item → resolve relative to crate root
    if (specifier.startsWith("crate::")) {
      const parts = specifier.replace(/^crate::/, "").split("::");
      // Strip the last segment if it looks like a type/fn (capitalized or contains {})
      const pathParts = parts.filter((p) => !p.includes("{") && !p.includes("*"));
      return normalize(join("src", pathParts.join("/")));
    }
    // mod declarations resolve to sibling files
    if (!specifier.includes("::")) {
      const dir = dirname(fromFile);
      const candidate = normalize(join(dir, specifier + ".rs"));
      if (knownFiles?.has(candidate)) return candidate;
      const modCandidate = normalize(join(dir, specifier, "mod.rs"));
      if (knownFiles?.has(modCandidate)) return modCandidate;
      return candidate;
    }
    // External crate or std — return as-is
    return specifier;
  }

  if (language === "java" || language === "scala") {
    // Java/Scala imports are fully-qualified (e.g. com.example.MyClass) — return as-is
    return specifier;
  }

  if (language === "csharp") {
    // C# using directives are namespace references — return as-is
    return specifier;
  }

  if (language === "ruby") {
    // require_relative resolves relative to the current file
    if (specifier.startsWith(".")) {
      const dir = dirname(fromFile);
      const resolved = normalize(join(dir, specifier));
      // Try with .rb extension
      if (knownFiles) {
        if (knownFiles.has(resolved + ".rb")) return resolved + ".rb";
        if (knownFiles.has(resolved)) return resolved;
      }
      return resolved;
    }
    // require "lib/helper" — return as-is (gem or load-path relative)
    return specifier;
  }

  return specifier;
}
