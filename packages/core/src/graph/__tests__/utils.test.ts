import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unpackRange, formatRange, getSnippet } from "../utils";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("unpackRange", () => {
  it("should unpack line and column from packed integer", () => {
    // line=5, col=10 → (5 << 16) | 10 = 327690
    const packed = (5 << 16) | 10;
    expect(unpackRange(packed)).toEqual({ line: 5, col: 10 });
  });

  it("should handle line=0, col=0", () => {
    expect(unpackRange(0)).toEqual({ line: 0, col: 0 });
  });

  it("should handle large line numbers", () => {
    const packed = (1000 << 16) | 42;
    expect(unpackRange(packed)).toEqual({ line: 1000, col: 42 });
  });
});

describe("formatRange", () => {
  it("should format start and end packed integers into a range object", () => {
    const start = (1 << 16) | 5;
    const end = (3 << 16) | 20;
    expect(formatRange(start, end)).toEqual({
      startLine: 1,
      startCol: 5,
      endLine: 3,
      endCol: 20,
    });
  });

  it("should handle single-line ranges", () => {
    const start = (10 << 16) | 0;
    const end = (10 << 16) | 15;
    expect(formatRange(start, end)).toEqual({
      startLine: 10,
      startCol: 0,
      endLine: 10,
      endCol: 15,
    });
  });
});

describe("getSnippet", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ariadne-utils-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return up to 3 lines starting at startLine", () => {
    const filePath = "src/test.ts";
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, filePath),
      "line0\nline1\nline2\nline3\nline4\n",
    );

    const snippet = getSnippet(tempDir, filePath, 1);
    expect(snippet).toBe("line1\nline2\nline3");
  });

  it("should return fewer lines if file is shorter", () => {
    const filePath = "short.ts";
    writeFileSync(join(tempDir, filePath), "only\ntwo\n");

    const snippet = getSnippet(tempDir, filePath, 0);
    expect(snippet).toBe("only\ntwo\n");
  });

  it("should return undefined for missing files", () => {
    expect(getSnippet(tempDir, "nonexistent.ts", 0)).toBeUndefined();
  });
});
