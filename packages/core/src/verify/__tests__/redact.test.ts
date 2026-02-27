import { describe, it, expect } from "vitest";
import { redactString, redactReport } from "../redact";

describe("redactString", () => {
  // ── GitHub tokens ─────────────────────────────────────────────────────

  it("should redact GitHub personal access tokens (classic)", () => {
    expect(redactString("token ghp_abc123def456ghi789jkl012")).toBe(
      "token [REDACTED]",
    );
  });

  it("should redact GitHub fine-grained tokens", () => {
    expect(redactString("github_pat_abcdef1234567890abcdef1234")).toBe(
      "[REDACTED]",
    );
  });

  it("should redact GitHub OAuth tokens", () => {
    expect(redactString("gho_abcdef1234567890abcdef")).toBe("[REDACTED]");
  });

  // ── Stripe keys ───────────────────────────────────────────────────────

  it("should redact Stripe secret keys", () => {
    expect(redactString("sk_test_abc123def456ghi789")).toBe("[REDACTED]");
  });

  it("should redact Stripe publishable keys", () => {
    expect(redactString("pk_live_abc123def456ghi789")).toContain("[REDACTED]");
  });

  // ── OpenAI keys ───────────────────────────────────────────────────────

  it("should redact OpenAI API keys", () => {
    expect(redactString("sk-proj123456789abcdef0123456789")).toBe(
      "[REDACTED]",
    );
  });

  // ── Anthropic keys ────────────────────────────────────────────────────

  it("should redact Anthropic API keys", () => {
    expect(redactString("sk-ant-api03-abcdef1234567890abcdef")).toBe(
      "[REDACTED]",
    );
  });

  // ── AWS keys ──────────────────────────────────────────────────────────

  it("should redact AWS access key IDs", () => {
    expect(redactString("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]");
  });

  // ── JWT tokens ────────────────────────────────────────────────────────

  it("should redact JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactString(jwt)).toBe("[REDACTED]");
  });

  // ── Connection strings ────────────────────────────────────────────────

  it("should redact postgres connection strings", () => {
    expect(
      redactString("postgres://user:pass@host:5432/db"),
    ).toBe("postgres://[REDACTED]");
  });

  it("should redact mongodb connection strings", () => {
    expect(
      redactString("mongodb://admin:secret@cluster.example.com/mydb"),
    ).toBe("mongodb://[REDACTED]");
  });

  it("should redact redis connection strings", () => {
    expect(
      redactString("redis://default:mypassword@redis.example.com:6379"),
    ).toBe("redis://[REDACTED]");
  });

  // ── Bearer auth ───────────────────────────────────────────────────────

  it("should redact Bearer tokens", () => {
    expect(
      redactString("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"),
    ).toContain("[REDACTED]");
  });

  // ── Env-style assignments ─────────────────────────────────────────────

  it("should redact API_KEY=value patterns", () => {
    expect(redactString("API_KEY=supersecretvalue123")).toBe(
      "API_KEY=[REDACTED]",
    );
  });

  it("should redact DATABASE_URL=value patterns", () => {
    expect(
      redactString("DATABASE_URL=postgres://user:pass@host/db"),
    ).toContain("[REDACTED]");
  });

  it("should redact SECRET_TOKEN=value patterns", () => {
    expect(redactString("SECRET_TOKEN=abcdef1234567890")).toBe(
      "SECRET_TOKEN=[REDACTED]",
    );
  });

  // ── Safe strings (no false positives) ─────────────────────────────────

  it("should NOT redact normal file paths", () => {
    const path = "src/components/Button.tsx(12,5): error TS2345: bad type";
    expect(redactString(path)).toBe(path);
  });

  it("should NOT redact short identifiers", () => {
    expect(redactString("const x = 42")).toBe("const x = 42");
  });

  it("should NOT redact normal error messages", () => {
    const msg =
      "Property 'foo' does not exist on type 'Bar'";
    expect(redactString(msg)).toBe(msg);
  });

  it("should NOT redact ariadne commands", () => {
    const cmd = "ariadne query impact src/store/queries.ts";
    expect(redactString(cmd)).toBe(cmd);
  });
});

describe("redactReport", () => {
  it("should deep-walk and redact strings in nested objects", () => {
    const report = {
      status: "FAIL",
      checks: {
        typecheck: {
          passed: false,
          issues: [
            {
              type: "TYPE_ERROR",
              message: "Token ghp_abc123def456ghi789jkl012 leaked",
            },
          ],
        },
      },
    };

    const redacted = redactReport(report);
    expect(redacted.checks.typecheck.issues[0].message).toBe(
      "Token [REDACTED] leaked",
    );
    // Original is NOT mutated
    expect(report.checks.typecheck.issues[0].message).toContain("ghp_");
  });

  it("should redact strings in arrays", () => {
    const arr = ["safe", "sk_test_abc123def456ghi789", "also safe"];
    const redacted = redactReport(arr);
    expect(redacted[0]).toBe("safe");
    expect(redacted[1]).toBe("[REDACTED]");
    expect(redacted[2]).toBe("also safe");
  });

  it("should pass through numbers and booleans", () => {
    const data = { count: 42, active: true, name: "test" };
    const redacted = redactReport(data);
    expect(redacted.count).toBe(42);
    expect(redacted.active).toBe(true);
    expect(redacted.name).toBe("test");
  });

  it("should handle null and undefined", () => {
    expect(redactReport(null)).toBeNull();
    expect(redactReport(undefined)).toBeUndefined();
  });

  it("should handle a realistic VerifyReport shape", () => {
    const report = {
      status: "FAIL" as const,
      timestamp: 1700000000000,
      checks: {
        indexFreshness: { passed: true, issues: [] },
        testCoverage: { passed: true, issues: [] },
        typecheck: {
          passed: false,
          issues: [
            {
              type: "TYPE_ERROR",
              message:
                "src/lib.ts(10,5): error TS2345: Argument of type 'string' is not assignable",
              file: "src/lib.ts",
              line: 10,
              col: 5,
              code: "TS2345",
              suggestedQueries: ["ariadne query impact src/lib.ts"],
            },
          ],
        },
      },
      summary: "failed checks: typecheck",
      recommendations: ["ariadne query impact src/lib.ts  # 1 error"],
    };

    const redacted = redactReport(report);
    // Nothing should be redacted — this report has no secrets
    expect(redacted.checks.typecheck.issues[0].message).toBe(
      report.checks.typecheck.issues[0].message,
    );
    expect(redacted.timestamp).toBe(report.timestamp);
    expect(redacted.summary).toBe(report.summary);
  });

  it("should redact secrets embedded in tsc error messages", () => {
    const report = {
      status: "FAIL" as const,
      timestamp: Date.now(),
      checks: {
        typecheck: {
          passed: false,
          issues: [
            {
              type: "TYPE_ERROR",
              message:
                "src/config.ts(3,7): error TS2322: Type 'DATABASE_URL=postgres://user:pass@host/db' is not assignable",
            },
          ],
        },
      },
      summary: "failed",
    };

    const redacted = redactReport(report);
    expect(redacted.checks.typecheck.issues[0].message).toContain(
      "[REDACTED]",
    );
    expect(redacted.checks.typecheck.issues[0].message).not.toContain(
      "user:pass",
    );
  });
});
