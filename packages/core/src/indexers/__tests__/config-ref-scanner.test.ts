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

  it("should detect Go os.Getenv references", () => {
    const code = 'url := os.Getenv("DATABASE_URL")';
    const refs = scanConfigRefs(code, "main.go", "go", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:DATABASE_URL");
  });

  it("should detect Go os.LookupEnv references", () => {
    const code = 'key, ok := os.LookupEnv("API_KEY")';
    const refs = scanConfigRefs(code, "config.go", "go", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:API_KEY");
  });

  it("should detect Rust env::var references", () => {
    const code = 'let url = env::var("DATABASE_URL").unwrap();';
    const refs = scanConfigRefs(code, "src/main.rs", "rust", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:DATABASE_URL");
  });

  it("should detect Rust env! macro references", () => {
    const code = 'let key = env!("API_KEY");';
    const refs = scanConfigRefs(code, "src/config.rs", "rust", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:API_KEY");
  });

  it("should detect Scala sys.env references", () => {
    const code = 'val url = sys.env("DATABASE_URL")';
    const refs = scanConfigRefs(code, "src/Config.scala", "scala", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:DATABASE_URL");
  });

  it("should detect Java System.getenv references", () => {
    const code = 'String url = System.getenv("DATABASE_URL");';
    const refs = scanConfigRefs(code, "src/Config.java", "java", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:DATABASE_URL");
  });

  it("should detect C# Environment.GetEnvironmentVariable references", () => {
    const code = 'var key = Environment.GetEnvironmentVariable("API_KEY");';
    const refs = scanConfigRefs(code, "src/Config.cs", "csharp", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:API_KEY");
  });

  it("should detect Ruby ENV references", () => {
    const code = 'url = ENV["DATABASE_URL"]';
    const refs = scanConfigRefs(code, "config/database.rb", "ruby", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:DATABASE_URL");
  });

  it("should detect Ruby ENV.fetch references", () => {
    const code = 'key = ENV.fetch("API_KEY")';
    const refs = scanConfigRefs(code, "config/secrets.rb", "ruby", envVars);
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe("artifact:env:API_KEY");
  });
});
