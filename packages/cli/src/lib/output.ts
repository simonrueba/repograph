export interface CliOutput {
  ok: boolean;
  kind: string;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export function output(kind: string, data: unknown): void {
  console.log(JSON.stringify({ ok: true, kind, data }));
}

export function outputError(
  code: string,
  message: string,
  details?: unknown,
): never {
  console.log(
    JSON.stringify({ ok: false, kind: "error", error: { code, message, details } }),
  );
  process.exit(1);
}
