export const SymbolRole = {
  UnspecifiedSymbolRole: 0,
  Definition: 1,
  Import: 2,
  WriteAccess: 4,
  ReadAccess: 8,
  Generated: 16,
  Test: 32,
  ForwardDefinition: 64,
} as const;

export interface ScipRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/**
 * SCIP ranges are encoded as [startLine, startCol, endCol] (single-line)
 * or [startLine, startCol, endLine, endCol] (multi-line).
 */
export function decodeScipRange(range: number[]): ScipRange {
  if (range.length === 3) {
    return {
      startLine: range[0],
      startCol: range[1],
      endLine: range[0],
      endCol: range[2],
    };
  }
  return {
    startLine: range[0],
    startCol: range[1],
    endLine: range[2],
    endCol: range[3],
  };
}

/**
 * Pack a range into two integers: (line << 16) | col
 */
export function packRange(r: ScipRange): { start: number; end: number } {
  return {
    start: (r.startLine << 16) | r.startCol,
    end: (r.endLine << 16) | r.endCol,
  };
}
