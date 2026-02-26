/**
 * Deep-walk a JSON-serialisable value and replace substrings that look like
 * secrets, tokens, or credentials with `[REDACTED]`.
 *
 * The goal is to prevent accidental prompt-injection when Claude (or any LLM)
 * ingests `verify_last.json`.  We intentionally over-match rather than
 * under-match — a false-positive redaction is harmless, a leaked key is not.
 */

const PLACEHOLDER = "[REDACTED]";

/**
 * Ordered list of patterns.  Each entry is applied via `String.replace` with
 * the global flag so multiple occurrences in a single string are caught.
 *
 * The patterns are intentionally broad:
 *  - Known prefixed tokens (GitHub, Stripe, AWS, Supabase, OpenAI, Anthropic …)
 *  - Generic "long hex / base64-ish" blobs (≥ 20 chars) that follow an `=` or
 *    appear after common env-var names
 *  - Connection strings with embedded credentials
 *  - Bearer / Basic auth headers
 */
const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // ── Prefixed API tokens ─────────────────────────────────────────────
  // GitHub tokens (classic + fine-grained)
  { pattern: /\bgh[ps]_[A-Za-z0-9_]{16,}\b/g, replacement: PLACEHOLDER },
  { pattern: /\bgho_[A-Za-z0-9_]{16,}\b/g, replacement: PLACEHOLDER },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replacement: PLACEHOLDER },

  // Stripe keys (sk_ secret, rk_ restricted, pk_ publishable)
  { pattern: /\b[srp]k_(test|live)_[A-Za-z0-9]{10,}\b/g, replacement: PLACEHOLDER },

  // OpenAI
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: PLACEHOLDER },

  // Anthropic
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: PLACEHOLDER },

  // AWS keys
  { pattern: /\bAKIA[A-Z0-9]{12,}\b/g, replacement: PLACEHOLDER },

  // Supabase / JWT-like
  { pattern: /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: PLACEHOLDER },

  // ── Connection strings ──────────────────────────────────────────────
  { pattern: /\b(postgres|mysql|mongodb|redis|amqp|nats):\/\/[^\s"']+/g, replacement: "$1://[REDACTED]" },

  // ── Bearer / Basic auth ─────────────────────────────────────────────
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9_.\-\/+=]{20,}\b/g, replacement: "$1 [REDACTED]" },

  // ── Generic env-style assignments: KEY=<long-value> ─────────────────
  // Matches lines like `DATABASE_URL=postgres://...` or `API_KEY=abc123...`
  { pattern: /\b([A-Z][A-Z0-9_]{2,}(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIALS|_URL|_DSN|_URI))=([^\s"']{8,})/g, replacement: "$1=[REDACTED]" },
];

/**
 * Redact secret-looking substrings from a single string value.
 */
export function redactString(value: string): string {
  let result = value;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Deep-walk a JSON-serialisable value and redact every string leaf.
 * Returns a **new** object — the original is not mutated.
 */
export function redactReport<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactReport(item)) as unknown as T;
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactReport(val);
    }
    return result as T;
  }

  // numbers, booleans — pass through
  return value;
}
