import { describe, it, expect } from "vitest";
import { scanConfigRefs } from "../config-ref-scanner";
import type { ArtifactSymbol } from "../artifact-extractor";

describe("scanConfigRefs", () => {
  const envVars: ArtifactSymbol[] = [
    {
      id: "artifact:env:DATABASE_URL",
      name: "DATABASE_URL",
      kind: "env_var",
      filePath: ".env",
      line: 0,
    },
    {
      id: "artifact:env:API_KEY",
      name: "API_KEY",
      kind: "env_var",
      filePath: ".env",
      line: 1,
    },
  ];

  const tables: ArtifactSymbol[] = [
    {
      id: "artifact:table:users",
      name: "users",
      kind: "table",
      filePath: "schema.sql",
      line: 0,
    },
  ];

  it("should detect process.env.KEY references", () => {
    const code = "const url = process.env.DATABASE_URL;";
    const refs = scanConfigRefs(code, "src/db.ts", "typescript", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:DATABASE_URL");
    expect(refs[0].kind).toBe("config_ref");
  });

  it('should detect process.env["KEY"] bracket references', () => {
    const code = 'const key = process.env["API_KEY"];';
    const refs = scanConfigRefs(code, "src/api.ts", "typescript", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:API_KEY");
  });

  it("should detect Python os.environ references", () => {
    const code = 'url = os.environ["DATABASE_URL"]';
    const refs = scanConfigRefs(code, "src/db.py", "python", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:DATABASE_URL");
  });

  it("should detect table names in SQL-like strings", () => {
    const code = 'const q = "SELECT * FROM users WHERE id = ?"';
    const refs = scanConfigRefs(code, "src/query.ts", "typescript", tables);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:table:users");
  });

  it("should not duplicate refs for same file+symbol", () => {
    const code =
      "const a = process.env.DATABASE_URL;\nconst b = process.env.DATABASE_URL;";
    const refs = scanConfigRefs(code, "src/db.ts", "typescript", envVars);
    expect(refs).toHaveLength(1);
  });

  it("should return empty for no matches", () => {
    const code = 'console.log("hello");';
    const refs = scanConfigRefs(code, "src/app.ts", "typescript", [
      ...envVars,
      ...tables,
    ]);
    expect(refs).toHaveLength(0);
  });
});
