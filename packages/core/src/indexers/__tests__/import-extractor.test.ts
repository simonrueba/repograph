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

  describe("unknown language", () => {
    it("should return empty array for unsupported languages", () => {
      const code = `use std::io;`;
      const result = extractImports(code, "rust");
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

  describe("unknown language", () => {
    it("should return specifier unchanged for unsupported languages", () => {
      const result = resolveModulePath("std::io", "src/main.rs", "rust");
      expect(result).toBe("std::io");
    });
  });
});
