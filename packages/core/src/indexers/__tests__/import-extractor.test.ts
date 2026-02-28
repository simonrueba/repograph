import { describe, it, expect } from "vitest";
import { extractImports, resolveModulePath } from "../import-extractor";

describe("extractImports", () => {
  describe("TypeScript / JavaScript", () => {
    it("should extract named ES module imports", () => {
      const code = `import { foo } from "./foo";`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([{ specifier: "./foo", kind: "import" }]);
    });

    it("should extract star imports", () => {
      const code = `import * as bar from "../bar";`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([{ specifier: "../bar", kind: "import" }]);
    });

    it("should extract default imports", () => {
      const code = `import baz from "baz";`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([{ specifier: "baz", kind: "import" }]);
    });

    it("should extract type imports", () => {
      const code = `import type { Qux } from "./qux";`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([{ specifier: "./qux", kind: "import" }]);
    });

    it("should extract re-exports", () => {
      const code = `export { something } from "./something";`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([{ specifier: "./something", kind: "export" }]);
    });

    it("should extract CommonJS require", () => {
      const code = `const a = require("./a");`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([{ specifier: "./a", kind: "import" }]);
    });

    it("should extract destructured require", () => {
      const code = `const { b } = require("b");`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([{ specifier: "b", kind: "import" }]);
    });

    it("should work with language 'javascript' too", () => {
      const code = `import { x } from "./x";`;
      const result = extractImports(code, "javascript");
      expect(result).toEqual([{ specifier: "./x", kind: "import" }]);
    });

    it("should handle multiple imports in one file", () => {
      const code = `
import { foo } from "./foo";
import * as bar from "../bar";
export { baz } from "./baz";
const x = require("lodash");
`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([
        { specifier: "./foo", kind: "import" },
        { specifier: "../bar", kind: "import" },
        { specifier: "./baz", kind: "export" },
        { specifier: "lodash", kind: "import" },
      ]);
    });

    it("should return empty array for code with no imports", () => {
      const code = `const x = 42;\nconsole.log(x);`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([]);
    });

    it("should extract side-effect imports", () => {
      const code = `import "./polyfill";\nimport "reflect-metadata";`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([
        { specifier: "./polyfill", kind: "import" },
        { specifier: "reflect-metadata", kind: "import" },
      ]);
    });

    it("should extract dynamic imports", () => {
      const code = `const mod = await import("./lazy-module");\nimport("./another");`;
      const result = extractImports(code, "typescript");
      expect(result).toEqual([
        { specifier: "./lazy-module", kind: "import" },
        { specifier: "./another", kind: "import" },
      ]);
    });

    it("should not duplicate side-effect imports already caught by main regex", () => {
      const code = `import { foo } from "./foo";\nimport "./bar";`;
      const result = extractImports(code, "typescript");
      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ specifier: "./foo", kind: "import" });
      expect(result).toContainEqual({ specifier: "./bar", kind: "import" });
    });
  });

  describe("Python", () => {
    it("should extract simple import", () => {
      const code = `import os`;
      const result = extractImports(code, "python");
      expect(result).toEqual([{ specifier: "os", kind: "import" }]);
    });

    it("should extract from import", () => {
      const code = `from pathlib import Path`;
      const result = extractImports(code, "python");
      expect(result).toEqual([{ specifier: "pathlib", kind: "import" }]);
    });

    it("should extract dotted module imports", () => {
      const code = `import os.path`;
      const result = extractImports(code, "python");
      expect(result).toEqual([{ specifier: "os.path", kind: "import" }]);
    });

    it("should extract from-import with dotted module", () => {
      const code = `from os.path import join`;
      const result = extractImports(code, "python");
      expect(result).toEqual([{ specifier: "os.path", kind: "import" }]);
    });

    it("should handle multiple Python imports", () => {
      const code = `
import os
from pathlib import Path
import sys
from collections import defaultdict
`;
      const result = extractImports(code, "python");
      expect(result).toEqual([
        { specifier: "os", kind: "import" },
        { specifier: "sys", kind: "import" },
        { specifier: "pathlib", kind: "import" },
        { specifier: "collections", kind: "import" },
      ]);
    });

    it("should return empty array for Python code with no imports", () => {
      const code = `x = 42\nprint(x)`;
      const result = extractImports(code, "python");
      expect(result).toEqual([]);
    });

    it("should extract relative imports (from . import X)", () => {
      const code = `from . import utils\nfrom .. import base`;
      const result = extractImports(code, "python");
      expect(result).toContainEqual({ specifier: ".", kind: "import" });
      expect(result).toContainEqual({ specifier: "..", kind: "import" });
    });

    it("should extract relative imports with module (from .utils import X)", () => {
      const code = `from .utils import helper`;
      const result = extractImports(code, "python");
      expect(result).toContainEqual({ specifier: ".utils", kind: "import" });
    });
  });

  describe("Go", () => {
    it("should extract single-line import", () => {
      const code = `import "fmt"`;
      const result = extractImports(code, "go");
      expect(result).toEqual([{ specifier: "fmt", kind: "import" }]);
    });

    it("should extract aliased import", () => {
      const code = `import f "fmt"`;
      const result = extractImports(code, "go");
      expect(result).toEqual([{ specifier: "fmt", kind: "import" }]);
    });

    it("should extract block imports", () => {
      const code = `import (
  "fmt"
  "os"
  "strings"
)`;
      const result = extractImports(code, "go");
      expect(result).toEqual([
        { specifier: "fmt", kind: "import" },
        { specifier: "os", kind: "import" },
        { specifier: "strings", kind: "import" },
      ]);
    });

    it("should extract block imports with aliases", () => {
      const code = `import (
  "fmt"
  log "github.com/sirupsen/logrus"
)`;
      const result = extractImports(code, "go");
      expect(result).toEqual([
        { specifier: "fmt", kind: "import" },
        { specifier: "github.com/sirupsen/logrus", kind: "import" },
      ]);
    });

    it("should return empty array for Go code with no imports", () => {
      const code = `package main\n\nfunc main() {}`;
      const result = extractImports(code, "go");
      expect(result).toEqual([]);
    });
  });

  describe("Rust", () => {
    it("should extract use statements", () => {
      const code = `use std::io;`;
      const result = extractImports(code, "rust");
      expect(result).toEqual([{ specifier: "std::io", kind: "import" }]);
    });

    it("should extract use with nested items", () => {
      const code = `use std::io::{Read, Write};`;
      const result = extractImports(code, "rust");
      expect(result).toEqual([{ specifier: "std::io::{Read, Write}", kind: "import" }]);
    });

    it("should extract use with glob", () => {
      const code = `use std::collections::*;`;
      const result = extractImports(code, "rust");
      expect(result).toEqual([{ specifier: "std::collections::*", kind: "import" }]);
    });

    it("should extract mod declarations", () => {
      const code = `mod utils;`;
      const result = extractImports(code, "rust");
      expect(result).toEqual([{ specifier: "utils", kind: "import" }]);
    });

    it("should extract extern crate", () => {
      const code = `extern crate serde;`;
      const result = extractImports(code, "rust");
      expect(result).toEqual([{ specifier: "serde", kind: "import" }]);
    });

    it("should extract crate-relative use", () => {
      const code = `use crate::models::User;`;
      const result = extractImports(code, "rust");
      expect(result).toEqual([{ specifier: "crate::models::User", kind: "import" }]);
    });

    it("should handle multiple Rust imports", () => {
      const code = `use std::io;
use std::collections::HashMap;
mod config;
extern crate log;`;
      const result = extractImports(code, "rust");
      expect(result).toEqual([
        { specifier: "std::io", kind: "import" },
        { specifier: "std::collections::HashMap", kind: "import" },
        { specifier: "config", kind: "import" },
        { specifier: "log", kind: "import" },
      ]);
    });

    it("should return empty array for Rust code with no imports", () => {
      const code = `fn main() { println!("hello"); }`;
      const result = extractImports(code, "rust");
      expect(result).toEqual([]);
    });
  });

  describe("Java", () => {
    it("should extract simple import", () => {
      const code = `import com.example.MyClass;`;
      const result = extractImports(code, "java");
      expect(result).toEqual([{ specifier: "com.example.MyClass", kind: "import" }]);
    });

    it("should extract static import", () => {
      const code = `import static org.junit.Assert.assertEquals;`;
      const result = extractImports(code, "java");
      expect(result).toEqual([{ specifier: "org.junit.Assert.assertEquals", kind: "import" }]);
    });

    it("should extract wildcard import", () => {
      const code = `import java.util.*;`;
      const result = extractImports(code, "java");
      expect(result).toEqual([{ specifier: "java.util.*", kind: "import" }]);
    });

    it("should handle multiple Java imports", () => {
      const code = `import java.util.List;
import java.util.Map;
import static java.lang.Math.PI;`;
      const result = extractImports(code, "java");
      expect(result).toEqual([
        { specifier: "java.util.List", kind: "import" },
        { specifier: "java.util.Map", kind: "import" },
        { specifier: "java.lang.Math.PI", kind: "import" },
      ]);
    });

    it("should return empty array for Java code with no imports", () => {
      const code = `public class Main { public static void main(String[] args) {} }`;
      const result = extractImports(code, "java");
      expect(result).toEqual([]);
    });
  });

  describe("C#", () => {
    it("should extract using directive", () => {
      const code = `using System.IO;`;
      const result = extractImports(code, "csharp");
      expect(result).toEqual([{ specifier: "System.IO", kind: "import" }]);
    });

    it("should extract static using", () => {
      const code = `using static System.Math;`;
      const result = extractImports(code, "csharp");
      expect(result).toEqual([{ specifier: "System.Math", kind: "import" }]);
    });

    it("should extract aliased using", () => {
      const code = `using Project = MyCompany.Project;`;
      const result = extractImports(code, "csharp");
      expect(result).toEqual([{ specifier: "MyCompany.Project", kind: "import" }]);
    });

    it("should handle multiple C# usings", () => {
      const code = `using System;
using System.Collections.Generic;
using System.Linq;`;
      const result = extractImports(code, "csharp");
      expect(result).toEqual([
        { specifier: "System", kind: "import" },
        { specifier: "System.Collections.Generic", kind: "import" },
        { specifier: "System.Linq", kind: "import" },
      ]);
    });

    it("should return empty array for C# code with no usings", () => {
      const code = `public class Program { static void Main() {} }`;
      const result = extractImports(code, "csharp");
      expect(result).toEqual([]);
    });
  });

  describe("Scala", () => {
    it("should extract simple import", () => {
      const code = `import scala.collection.mutable`;
      const result = extractImports(code, "scala");
      expect(result).toEqual([{ specifier: "scala.collection.mutable", kind: "import" }]);
    });

    it("should extract wildcard import", () => {
      const code = `import scala.collection.mutable._`;
      const result = extractImports(code, "scala");
      expect(result).toEqual([{ specifier: "scala.collection.mutable._", kind: "import" }]);
    });

    it("should extract selective import", () => {
      const code = `import scala.collection.mutable.{Map, Set}`;
      const result = extractImports(code, "scala");
      expect(result).toEqual([{ specifier: "scala.collection.mutable.{Map, Set}", kind: "import" }]);
    });

    it("should handle multiple Scala imports", () => {
      const code = `import scala.io.Source
import java.util.Date
import akka.actor._`;
      const result = extractImports(code, "scala");
      expect(result).toEqual([
        { specifier: "scala.io.Source", kind: "import" },
        { specifier: "java.util.Date", kind: "import" },
        { specifier: "akka.actor._", kind: "import" },
      ]);
    });

    it("should return empty array for Scala code with no imports", () => {
      const code = `object Main extends App { println("hello") }`;
      const result = extractImports(code, "scala");
      expect(result).toEqual([]);
    });
  });

  describe("Ruby", () => {
    it("should extract require", () => {
      const code = `require "json"`;
      const result = extractImports(code, "ruby");
      expect(result).toEqual([{ specifier: "json", kind: "import" }]);
    });

    it("should extract require with single quotes", () => {
      const code = `require 'yaml'`;
      const result = extractImports(code, "ruby");
      expect(result).toEqual([{ specifier: "yaml", kind: "import" }]);
    });

    it("should extract require_relative", () => {
      const code = `require_relative "lib/helper"`;
      const result = extractImports(code, "ruby");
      expect(result).toEqual([{ specifier: "lib/helper", kind: "import" }]);
    });

    it("should extract load", () => {
      const code = `load "config.rb"`;
      const result = extractImports(code, "ruby");
      expect(result).toEqual([{ specifier: "config.rb", kind: "import" }]);
    });

    it("should handle multiple Ruby requires", () => {
      const code = `require "json"
require "net/http"
require_relative "./utils"`;
      const result = extractImports(code, "ruby");
      expect(result).toEqual([
        { specifier: "json", kind: "import" },
        { specifier: "net/http", kind: "import" },
        { specifier: "./utils", kind: "import" },
      ]);
    });

    it("should return empty array for Ruby code with no requires", () => {
      const code = `puts "hello world"`;
      const result = extractImports(code, "ruby");
      expect(result).toEqual([]);
    });
  });

  describe("unknown language", () => {
    it("should return empty array for unsupported languages", () => {
      const code = `#include <stdio.h>`;
      const result = extractImports(code, "c");
      expect(result).toEqual([]);
    });
  });
});

describe("resolveModulePath", () => {
  describe("TypeScript / JavaScript", () => {
    it("should resolve relative import in same directory", () => {
      const result = resolveModulePath("./foo", "src/main.ts", "typescript");
      expect(result).toBe("src/foo");
    });

    it("should resolve parent-relative import", () => {
      const result = resolveModulePath("../utils", "src/deep/file.ts", "typescript");
      expect(result).toBe("src/utils");
    });

    it("should leave bare specifier unchanged", () => {
      const result = resolveModulePath("lodash", "src/main.ts", "typescript");
      expect(result).toBe("lodash");
    });

    it("should resolve deeply nested relative import", () => {
      const result = resolveModulePath("../../lib/helpers", "src/a/b/c.ts", "typescript");
      expect(result).toBe("src/lib/helpers");
    });

    it("should work with language 'javascript'", () => {
      const result = resolveModulePath("./bar", "src/index.js", "javascript");
      expect(result).toBe("src/bar");
    });
  });

  describe("Python", () => {
    it("should leave absolute Python module unchanged", () => {
      const result = resolveModulePath("os", "src/main.py", "python");
      expect(result).toBe("os");
    });

    it("should leave dotted absolute Python module unchanged", () => {
      const result = resolveModulePath("os.path", "src/main.py", "python");
      expect(result).toBe("os.path");
    });
  });

  describe("with knownFiles", () => {
    const knownFiles = new Set([
      "src/utils.ts",
      "src/helpers/index.ts",
      "src/components/Button.tsx",
      "src/lib.js",
    ]);

    it("should resolve to .ts extension when file exists in knownFiles", () => {
      const result = resolveModulePath("./utils", "src/main.ts", "typescript", knownFiles);
      expect(result).toBe("src/utils.ts");
    });

    it("should resolve to .tsx extension when file exists in knownFiles", () => {
      const result = resolveModulePath("./components/Button", "src/app.ts", "typescript", knownFiles);
      expect(result).toBe("src/components/Button.tsx");
    });

    it("should resolve to index.ts when directory has index file", () => {
      const result = resolveModulePath("./helpers", "src/app.ts", "typescript", knownFiles);
      expect(result).toBe("src/helpers/index.ts");
    });

    it("should resolve to .js extension when file exists in knownFiles", () => {
      const result = resolveModulePath("./lib", "src/main.ts", "typescript", knownFiles);
      expect(result).toBe("src/lib.js");
    });

    it("should return original path when no match in knownFiles", () => {
      const result = resolveModulePath("./missing", "src/main.ts", "typescript", knownFiles);
      expect(result).toBe("src/missing");
    });

    it("should return exact path when already in knownFiles", () => {
      const result = resolveModulePath("./utils.ts", "src/main.ts", "typescript", knownFiles);
      expect(result).toBe("src/utils.ts");
    });

    it("should not resolve bare specifiers even with knownFiles", () => {
      const result = resolveModulePath("lodash", "src/main.ts", "typescript", knownFiles);
      expect(result).toBe("lodash");
    });

    it("should work without knownFiles (backward compat)", () => {
      const result = resolveModulePath("./utils", "src/main.ts", "typescript");
      expect(result).toBe("src/utils");
    });
  });

  describe("Go", () => {
    it("should return Go package path unchanged", () => {
      const result = resolveModulePath("fmt", "main.go", "go");
      expect(result).toBe("fmt");
    });

    it("should return Go module path unchanged", () => {
      const result = resolveModulePath("github.com/user/pkg", "main.go", "go");
      expect(result).toBe("github.com/user/pkg");
    });
  });

  describe("Rust", () => {
    it("should resolve crate-relative use to src path", () => {
      const result = resolveModulePath("crate::models::User", "src/main.rs", "rust");
      expect(result).toBe("src/models/User");
    });

    it("should resolve mod declaration to sibling file", () => {
      const knownFiles = new Set(["src/utils.rs"]);
      const result = resolveModulePath("utils", "src/main.rs", "rust", knownFiles);
      expect(result).toBe("src/utils.rs");
    });

    it("should resolve mod declaration to mod.rs", () => {
      const knownFiles = new Set(["src/utils/mod.rs"]);
      const result = resolveModulePath("utils", "src/main.rs", "rust", knownFiles);
      expect(result).toBe("src/utils/mod.rs");
    });

    it("should return external crate path unchanged", () => {
      const result = resolveModulePath("std::io", "src/main.rs", "rust");
      expect(result).toBe("std::io");
    });
  });

  describe("Java", () => {
    it("should return Java package path unchanged", () => {
      const result = resolveModulePath("com.example.MyClass", "src/Main.java", "java");
      expect(result).toBe("com.example.MyClass");
    });
  });

  describe("Scala", () => {
    it("should return Scala package path unchanged", () => {
      const result = resolveModulePath("scala.collection.mutable", "src/Main.scala", "scala");
      expect(result).toBe("scala.collection.mutable");
    });
  });

  describe("C#", () => {
    it("should return C# namespace unchanged", () => {
      const result = resolveModulePath("System.IO", "src/Program.cs", "csharp");
      expect(result).toBe("System.IO");
    });
  });

  describe("Ruby", () => {
    it("should return gem require unchanged", () => {
      const result = resolveModulePath("json", "lib/app.rb", "ruby");
      expect(result).toBe("json");
    });

    it("should resolve relative require_relative path", () => {
      const knownFiles = new Set(["lib/utils.rb"]);
      const result = resolveModulePath("./utils", "lib/app.rb", "ruby", knownFiles);
      expect(result).toBe("lib/utils.rb");
    });

    it("should resolve relative path without .rb when file exists", () => {
      const knownFiles = new Set(["lib/helper.rb"]);
      const result = resolveModulePath("./helper", "lib/app.rb", "ruby", knownFiles);
      expect(result).toBe("lib/helper.rb");
    });
  });

  describe("unknown language", () => {
    it("should return specifier unchanged for unsupported languages", () => {
      const result = resolveModulePath("#include <stdio.h>", "src/main.c", "c");
      expect(result).toBe("#include <stdio.h>");
    });
  });
});
