import { describe, it, expect } from "vitest";
import { extractArtifacts } from "../artifact-extractor";

describe("extractArtifacts", () => {
  describe(".env files", () => {
    it("should extract env vars from .env", () => {
      const content =
        "DATABASE_URL=postgres://localhost\nAPI_KEY=secret123\n# comment\nDEBUG=true";
      const result = extractArtifacts(".env", content);
      expect(result).toHaveLength(3);
      expect(result[0].name).toBe("DATABASE_URL");
      expect(result[0].kind).toBe("env_var");
      expect(result[0].id).toBe("artifact:env:DATABASE_URL");
    });

    it("should skip comments and empty lines", () => {
      const content = "# comment\n\nKEY=value\n";
      const result = extractArtifacts(".env", content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("KEY");
    });
  });

  describe("package.json", () => {
    it("should extract scripts", () => {
      const content = JSON.stringify({
        name: "my-app",
        scripts: { dev: "bun run dev", build: "bun build" },
      });
      const result = extractArtifacts("package.json", content);
      const scripts = result.filter(
        (s) => s.kind === "config_key" && s.id.startsWith("artifact:script:"),
      );
      expect(scripts).toHaveLength(2);
      expect(scripts.map((s) => s.name)).toContain("dev");
      expect(scripts.map((s) => s.name)).toContain("build");
    });

    it("should extract top-level keys", () => {
      const content = JSON.stringify({ name: "test", version: "1.0.0" });
      const result = extractArtifacts("package.json", content);
      const keys = result.filter((s) => s.id.startsWith("artifact:pkg:"));
      expect(keys.map((s) => s.name)).toContain("name");
      expect(keys.map((s) => s.name)).toContain("version");
    });
  });

  describe("SQL files", () => {
    it("should extract CREATE TABLE statements", () => {
      const content =
        "CREATE TABLE users (\n  id INTEGER PRIMARY KEY\n);";
      const result = extractArtifacts("migrations/001.sql", content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("users");
      expect(result[0].kind).toBe("table");
    });

    it("should extract CREATE INDEX statements", () => {
      const content = "CREATE INDEX idx_users_email ON users(email);";
      const result = extractArtifacts("migrations/002.sql", content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("idx_users_email");
      expect(result[0].kind).toBe("index");
    });
  });

  describe("tsconfig.json", () => {
    it("should extract compilerOptions keys", () => {
      const content = JSON.stringify({
        compilerOptions: { strict: true, target: "es2020" },
      });
      const result = extractArtifacts("tsconfig.json", content);
      expect(result.map((s) => s.name)).toContain("strict");
      expect(result.map((s) => s.name)).toContain("target");
    });
  });

  describe(".env variants", () => {
    it("should extract from .env.local", () => {
      const result = extractArtifacts(".env.local", "LOCAL_VAR=abc\n");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("LOCAL_VAR");
      expect(result[0].id).toBe("artifact:env:LOCAL_VAR");
    });

    it("should extract from .env.production", () => {
      const result = extractArtifacts("config/.env.production", "PROD_KEY=secret\nPROD_URL=https://example.com\n");
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("PROD_KEY");
      expect(result[1].name).toBe("PROD_URL");
    });

    it("should track correct line numbers", () => {
      const content = "# header comment\n\nFIRST=1\n# another comment\nSECOND=2\n";
      const result = extractArtifacts(".env", content);
      expect(result).toHaveLength(2);
      expect(result[0].line).toBe(2); // 0-indexed, line 3
      expect(result[1].line).toBe(4); // 0-indexed, line 5
    });
  });

  describe("package.json edge cases", () => {
    it("should handle invalid JSON gracefully", () => {
      const result = extractArtifacts("package.json", "{ invalid json }}}");
      expect(result).toEqual([]);
    });

    it("should handle missing scripts section", () => {
      const content = JSON.stringify({ name: "test", version: "1.0.0" });
      const result = extractArtifacts("package.json", content);
      // Should still extract top-level keys
      const pkgKeys = result.filter(s => s.id.startsWith("artifact:pkg:"));
      expect(pkgKeys.map(s => s.name)).toContain("name");
      expect(pkgKeys.map(s => s.name)).toContain("version");
    });

    it("should extract bin, main, module, types keys", () => {
      const content = JSON.stringify({
        name: "my-lib",
        main: "./dist/index.js",
        module: "./dist/index.mjs",
        types: "./dist/index.d.ts",
        bin: { mycli: "./bin/cli.js" },
      });
      const result = extractArtifacts("package.json", content);
      const pkgKeys = result.filter(s => s.id.startsWith("artifact:pkg:"));
      expect(pkgKeys.map(s => s.name)).toContain("main");
      expect(pkgKeys.map(s => s.name)).toContain("module");
      expect(pkgKeys.map(s => s.name)).toContain("types");
      expect(pkgKeys.map(s => s.name)).toContain("bin");
    });
  });

  describe("tsconfig.json edge cases", () => {
    it("should handle invalid JSON gracefully", () => {
      const result = extractArtifacts("tsconfig.json", "not valid json");
      expect(result).toEqual([]);
    });

    it("should handle missing compilerOptions", () => {
      const content = JSON.stringify({ include: ["src"] });
      const result = extractArtifacts("tsconfig.json", content);
      expect(result).toEqual([]);
    });

    it("should extract all compilerOptions keys", () => {
      const content = JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "es2020",
          module: "esnext",
          outDir: "./dist",
          declaration: true,
        },
      });
      const result = extractArtifacts("tsconfig.json", content);
      expect(result).toHaveLength(5);
      expect(result.map(s => s.name)).toContain("declaration");
    });
  });

  describe("SQL edge cases", () => {
    it("should extract ALTER TABLE statements", () => {
      const content = 'ALTER TABLE users ADD COLUMN email TEXT;\n';
      const result = extractArtifacts("migrations/003.sql", content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("users");
      expect(result[0].kind).toBe("table");
    });

    it("should extract CREATE TABLE IF NOT EXISTS", () => {
      const content = "CREATE TABLE IF NOT EXISTS sessions (\n  id TEXT PRIMARY KEY\n);\n";
      const result = extractArtifacts("schema.sql", content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("sessions");
      expect(result[0].kind).toBe("table");
    });

    it("should extract CREATE UNIQUE INDEX", () => {
      const content = "CREATE UNIQUE INDEX idx_email ON users(email);\n";
      const result = extractArtifacts("indexes.sql", content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("idx_email");
      expect(result[0].kind).toBe("index");
    });

    it("should extract CREATE INDEX IF NOT EXISTS", () => {
      const content = "CREATE INDEX IF NOT EXISTS idx_name ON users(name);\n";
      const result = extractArtifacts("indexes.sql", content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("idx_name");
    });

    it("should extract multiple SQL statements from one file", () => {
      const content = [
        "CREATE TABLE users (id INTEGER PRIMARY KEY);",
        "CREATE TABLE posts (id INTEGER PRIMARY KEY);",
        "ALTER TABLE posts ADD COLUMN user_id INTEGER;",
        "CREATE INDEX idx_posts_user ON posts(user_id);",
      ].join("\n");
      const result = extractArtifacts("schema.sql", content);
      // 2 create tables + 1 alter table (posts appears twice) + 1 index
      expect(result.length).toBeGreaterThanOrEqual(4);
    });

    it("should handle quoted table names", () => {
      const content = 'CREATE TABLE "my_table" (id INTEGER);\n';
      const result = extractArtifacts("schema.sql", content);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("my_table");
    });
  });

  describe("OpenAPI JSON files", () => {
    it("should extract paths from openapi.json", () => {
      const content = JSON.stringify({
        openapi: "3.0.0",
        paths: {
          "/users": { get: { summary: "List users" } },
          "/users/{id}": { get: { summary: "Get user" } },
        },
      });
      const result = extractArtifacts("openapi.json", content);
      const endpoints = result.filter(s => s.kind === "api_endpoint");
      expect(endpoints).toHaveLength(2);
      expect(endpoints.map(s => s.name)).toContain("/users");
      expect(endpoints.map(s => s.name)).toContain("/users/{id}");
    });

    it("should extract schemas from components.schemas", () => {
      const content = JSON.stringify({
        openapi: "3.0.0",
        paths: {},
        components: {
          schemas: {
            User: { type: "object", properties: { id: { type: "string" } } },
            Post: { type: "object", properties: { title: { type: "string" } } },
          },
        },
      });
      const result = extractArtifacts("openapi.json", content);
      const schemas = result.filter(s => s.kind === "api_schema");
      expect(schemas).toHaveLength(2);
      expect(schemas.map(s => s.name)).toContain("User");
      expect(schemas.map(s => s.name)).toContain("Post");
    });

    it("should extract schemas from definitions (Swagger 2.0)", () => {
      const content = JSON.stringify({
        swagger: "2.0",
        paths: { "/health": { get: {} } },
        definitions: {
          HealthCheck: { type: "object" },
        },
      });
      const result = extractArtifacts("openapi.json", content);
      const schemas = result.filter(s => s.kind === "api_schema");
      expect(schemas).toHaveLength(1);
      expect(schemas[0].name).toBe("HealthCheck");
    });

    it("should handle invalid JSON in openapi.json", () => {
      const result = extractArtifacts("openapi.json", "not valid json{{{");
      expect(result).toEqual([]);
    });
  });

  describe("OpenAPI YAML files", () => {
    it("should extract paths from openapi.yaml", () => {
      const content = [
        "openapi: 3.0.0",
        "paths:",
        "  /users:",
        "    get:",
        "      summary: List users",
        "  /posts:",
        "    get:",
        "      summary: List posts",
      ].join("\n");
      const result = extractArtifacts("openapi.yaml", content);
      const endpoints = result.filter(s => s.kind === "api_endpoint");
      expect(endpoints).toHaveLength(2);
      expect(endpoints.map(s => s.name)).toContain("/users");
      expect(endpoints.map(s => s.name)).toContain("/posts");
    });

    it("should extract schemas from openapi.yml", () => {
      const content = [
        "openapi: 3.0.0",
        "components:",
        "  schemas:",
        "    User:",
        "      type: object",
        "    Post:",
        "      type: object",
      ].join("\n");
      const result = extractArtifacts("openapi.yml", content);
      const schemas = result.filter(s => s.kind === "api_schema");
      expect(schemas).toHaveLength(2);
      expect(schemas.map(s => s.name)).toContain("User");
      expect(schemas.map(s => s.name)).toContain("Post");
    });
  });

  describe("unsupported files", () => {
    it("should return empty array for unknown files", () => {
      expect(extractArtifacts("readme.md", "# Hello")).toEqual([]);
    });

    it("should return empty array for .js files", () => {
      expect(extractArtifacts("index.js", "module.exports = {}")).toEqual([]);
    });

    it("should return empty array for .ts files", () => {
      expect(extractArtifacts("index.ts", "export const x = 1;")).toEqual([]);
    });
  });
});
