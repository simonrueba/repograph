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

  describe("unsupported files", () => {
    it("should return empty array for unknown files", () => {
      expect(extractArtifacts("readme.md", "# Hello")).toEqual([]);
    });
  });
});
