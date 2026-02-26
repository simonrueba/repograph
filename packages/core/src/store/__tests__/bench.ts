/**
 * Micro-benchmark for the performance-critical store operations.
 *
 * Measures old (N+1) patterns vs new batched/cached alternatives.
 * Run with: bun run packages/core/src/store/__tests__/bench.ts
 */
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase } from "../db";
import {
  StoreQueries,
  type EdgeRecord,
  type SymbolRecord,
  type OccurrenceRecord,
} from "../queries";

// ── Helpers ──────────────────────────────────────────────────────────

function hrMs(start: [number, number]): number {
  const [ds, dns] = process.hrtime(start);
  return ds * 1e3 + dns / 1e6;
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

function banner(title: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}`);
}

// ── Setup ────────────────────────────────────────────────────────────

const NUM_FILES = 50;
const SYMBOLS_PER_FILE = 100; // 5 000 total symbols
const REFS_PER_FILE = 200; // 10 000 total edges/occurrences
const TOTAL_SYMBOLS = NUM_FILES * SYMBOLS_PER_FILE;
const TOTAL_EDGES = NUM_FILES * REFS_PER_FILE;

const dir = mkdtempSync(join(tmpdir(), "repograph-bench-"));
const dbPath = join(dir, "bench.db");
const db = createDatabase(dbPath);
const store = new StoreQueries(db);

console.log(`Benchmark DB: ${dbPath}`);
console.log(`Dataset: ${NUM_FILES} files, ${TOTAL_SYMBOLS} symbols, ${TOTAL_EDGES} edges\n`);

// Seed files
for (let f = 0; f < NUM_FILES; f++) {
  store.upsertFile({ path: `src/file_${f}.ts`, language: "typescript", hash: `h${f}` });
}

// Seed symbols — each symbol "defined" in its file
for (let f = 0; f < NUM_FILES; f++) {
  for (let s = 0; s < SYMBOLS_PER_FILE; s++) {
    store.upsertSymbol({
      id: `sym_${f}_${s}`,
      kind: "function",
      name: `func_${f}_${s}`,
      file_path: `src/file_${f}.ts`,
    });
  }
}

// ── Bench 1: Edge inserts ────────────────────────────────────────────

banner("1. Edge inserts — individual vs multi-row batch");

function buildEdges(): EdgeRecord[] {
  const edges: EdgeRecord[] = [];
  for (let f = 0; f < NUM_FILES; f++) {
    for (let r = 0; r < REFS_PER_FILE; r++) {
      const targetFile = (f + 1 + (r % (NUM_FILES - 1))) % NUM_FILES;
      const targetSym = r % SYMBOLS_PER_FILE;
      edges.push({
        source: `src/file_${f}.ts`,
        target: `sym_${targetFile}_${targetSym}`,
        kind: "references",
        confidence: "high",
      });
    }
  }
  return edges;
}

// Individual inserts
{
  store.clearAllEdges();
  const edges = buildEdges();
  const t = process.hrtime();
  store.transaction(() => {
    for (const edge of edges) {
      store.insertEdge(edge);
    }
  });
  const ms = hrMs(t);
  console.log(`  insertEdge() x ${edges.length}:  ${fmt(ms)}  (${fmt(ms / edges.length)}/op)`);
}

// Multi-row batch inserts
{
  store.clearAllEdges();
  const edges = buildEdges();
  const t = process.hrtime();
  store.transaction(() => {
    store.insertEdges(edges);
  });
  const ms = hrMs(t);
  console.log(`  insertEdges() x ${edges.length}: ${fmt(ms)}  (${fmt(ms / edges.length)}/op)`);
}

// ── Bench 2: Occurrence upserts ──────────────────────────────────────

banner("2. Occurrence upserts — individual vs multi-row batch");

function buildOccurrences(): OccurrenceRecord[] {
  const occs: OccurrenceRecord[] = [];
  for (let f = 0; f < NUM_FILES; f++) {
    for (let r = 0; r < REFS_PER_FILE; r++) {
      const targetFile = (f + 1 + (r % (NUM_FILES - 1))) % NUM_FILES;
      const targetSym = r % SYMBOLS_PER_FILE;
      occs.push({
        file_path: `src/file_${f}.ts`,
        range_start: r * 100,
        range_end: r * 100 + 50,
        symbol_id: `sym_${targetFile}_${targetSym}`,
        roles: 0,
      });
    }
  }
  return occs;
}

// Individual upserts
{
  store.clearAllOccurrences();
  const occs = buildOccurrences();
  const t = process.hrtime();
  store.transaction(() => {
    for (const occ of occs) {
      store.upsertOccurrence(occ);
    }
  });
  const ms = hrMs(t);
  console.log(`  upsertOccurrence() x ${occs.length}:  ${fmt(ms)}  (${fmt(ms / occs.length)}/op)`);
}

// Multi-row batch upserts
{
  store.clearAllOccurrences();
  const occs = buildOccurrences();
  const t = process.hrtime();
  store.transaction(() => {
    store.upsertOccurrences(occs);
  });
  const ms = hrMs(t);
  console.log(`  upsertOccurrences() x ${occs.length}: ${fmt(ms)}  (${fmt(ms / occs.length)}/op)`);
}

// ── Bench 3: Symbol upserts ─────────────────────────────────────────

banner("3. Symbol upserts — individual vs multi-row batch");

function buildSymbols(): SymbolRecord[] {
  const syms: SymbolRecord[] = [];
  for (let f = 0; f < NUM_FILES; f++) {
    for (let s = 0; s < SYMBOLS_PER_FILE; s++) {
      syms.push({
        id: `newsym_${f}_${s}`,
        kind: "function",
        name: `newfunc_${f}_${s}`,
        file_path: `src/file_${f}.ts`,
      });
    }
  }
  return syms;
}

// Individual upserts
{
  store.clearAllSymbols();
  const syms = buildSymbols();
  const t = process.hrtime();
  store.transaction(() => {
    for (const sym of syms) {
      store.upsertSymbol(sym);
    }
  });
  const ms = hrMs(t);
  console.log(`  upsertSymbol() x ${syms.length}:  ${fmt(ms)}  (${fmt(ms / syms.length)}/op)`);
}

// Multi-row batch upserts
{
  store.clearAllSymbols();
  const syms = buildSymbols();
  const t = process.hrtime();
  store.transaction(() => {
    store.upsertSymbols(syms);
  });
  const ms = hrMs(t);
  console.log(`  upsertSymbols() x ${syms.length}: ${fmt(ms)}  (${fmt(ms / syms.length)}/op)`);
}

// Re-seed symbols for remaining benchmarks
store.clearAllSymbols();
for (let f = 0; f < NUM_FILES; f++) {
  for (let s = 0; s < SYMBOLS_PER_FILE; s++) {
    store.upsertSymbol({
      id: `sym_${f}_${s}`,
      kind: "function",
      name: `func_${f}_${s}`,
      file_path: `src/file_${f}.ts`,
    });
  }
}

// ── Bench 4: Symbol count ────────────────────────────────────────────

banner("4. Symbol count — searchSymbols('').length vs getSymbolCount()");

{
  const ITERS = 50;

  const t1 = process.hrtime();
  for (let i = 0; i < ITERS; i++) {
    store.searchSymbols("").length;
  }
  const ms1 = hrMs(t1);

  const t2 = process.hrtime();
  for (let i = 0; i < ITERS; i++) {
    store.getSymbolCount();
  }
  const ms2 = hrMs(t2);

  console.log(`  searchSymbols("").length x ${ITERS}: ${fmt(ms1)}  (${fmt(ms1 / ITERS)}/call)`);
  console.log(`  getSymbolCount()        x ${ITERS}: ${fmt(ms2)}  (${fmt(ms2 / ITERS)}/call)`);
  console.log(`  Speedup: ${(ms1 / ms2).toFixed(1)}x`);
}

// ── Bench 5: Symbol lookup — individual getSymbol() vs in-memory cache ──

banner("5. Symbol lookup — getSymbol() N times vs cache hit");

{
  const symbolIds: string[] = [];
  for (let f = 0; f < NUM_FILES; f++) {
    for (let s = 0; s < SYMBOLS_PER_FILE; s++) {
      symbolIds.push(`sym_${f}_${s}`);
    }
  }

  // Individual DB lookups
  const t1 = process.hrtime();
  for (const id of symbolIds) {
    store.getSymbol(id);
  }
  const ms1 = hrMs(t1);

  // In-memory cache (Map.get)
  const cache = new Map<string, SymbolRecord>();
  for (const id of symbolIds) {
    const sym = store.getSymbol(id);
    if (sym) cache.set(id, sym);
  }

  const t2 = process.hrtime();
  for (const id of symbolIds) {
    cache.get(id);
  }
  const ms2 = hrMs(t2);

  console.log(`  getSymbol() x ${symbolIds.length}:  ${fmt(ms1)}  (${fmt(ms1 / symbolIds.length)}/op)`);
  console.log(`  Map.get()   x ${symbolIds.length}:  ${fmt(ms2)}  (${fmt(ms2 / symbolIds.length)}/op)`);
  console.log(`  Speedup: ${(ms1 / ms2).toFixed(0)}x`);
}

// ── Bench 6: Symbol file map — per-occ getSymbol() vs pre-loaded map ──

banner("6. Semantic edges — per-occurrence getSymbol() vs getSymbolFileMap()");

{
  const occSymbolIds: string[] = [];
  for (let f = 0; f < NUM_FILES; f++) {
    for (let r = 0; r < REFS_PER_FILE; r++) {
      const targetFile = (f + 1 + (r % (NUM_FILES - 1))) % NUM_FILES;
      const targetSym = r % SYMBOLS_PER_FILE;
      occSymbolIds.push(`sym_${targetFile}_${targetSym}`);
    }
  }

  // Old: individual getSymbol() for each occurrence
  const t1 = process.hrtime();
  for (const id of occSymbolIds) {
    const sym = store.getSymbol(id);
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    sym?.file_path;
  }
  const ms1 = hrMs(t1);

  // New: load map once, then do Map.get()
  const t2 = process.hrtime();
  const fileMap = store.getSymbolFileMap();
  for (const id of occSymbolIds) {
    fileMap.get(id);
  }
  const ms2 = hrMs(t2);

  console.log(`  getSymbol() x ${occSymbolIds.length}:     ${fmt(ms1)}  (${fmt(ms1 / occSymbolIds.length)}/op)`);
  console.log(`  getSymbolFileMap() + Map.get(): ${fmt(ms2)}  (map load + ${occSymbolIds.length} lookups)`);
  console.log(`  Speedup: ${(ms1 / ms2).toFixed(1)}x`);
}

// ── Bench 7: File lookup — getAllFiles() vs scoped getFile() ─────────

banner("7. File lookup — getAllFiles() full scan vs getFile() scoped (10 files)");

{
  const SCOPE_SIZE = 10;
  const ITERS = 100;
  const scopedPaths = Array.from({ length: SCOPE_SIZE }, (_, i) => `src/file_${i}.ts`);

  // Old: getAllFiles() and build map
  const t1 = process.hrtime();
  for (let i = 0; i < ITERS; i++) {
    const allFiles = store.getAllFiles();
    const map = new Map(allFiles.map((f) => [f.path, f]));
    for (const p of scopedPaths) {
      map.get(p);
    }
  }
  const ms1 = hrMs(t1);

  // New: getFile() per scoped path
  const t2 = process.hrtime();
  for (let i = 0; i < ITERS; i++) {
    for (const p of scopedPaths) {
      store.getFile(p);
    }
  }
  const ms2 = hrMs(t2);

  console.log(`  getAllFiles() + Map     x ${ITERS}: ${fmt(ms1)}  (${fmt(ms1 / ITERS)}/iter, ${NUM_FILES} files scanned)`);
  console.log(`  getFile() x ${SCOPE_SIZE} scoped x ${ITERS}: ${fmt(ms2)}  (${fmt(ms2 / ITERS)}/iter)`);
  console.log(`  Speedup: ${(ms1 / ms2).toFixed(1)}x  (crossover ~150 files; wins at scale)`);
}

// ── Bench 8: transaction() vs bulkTransaction() ─────────────────────

banner("8. Full ingest — transaction() vs bulkTransaction()");

{
  function seedEdgesAndSymbols(s: StoreQueries): void {
    const edges: EdgeRecord[] = [];
    const syms: SymbolRecord[] = [];
    for (let f = 0; f < NUM_FILES; f++) {
      for (let r = 0; r < REFS_PER_FILE; r++) {
        const targetFile = (f + 1 + (r % (NUM_FILES - 1))) % NUM_FILES;
        const targetSym = r % SYMBOLS_PER_FILE;
        edges.push({
          source: `src/file_${f}.ts`,
          target: `sym_${targetFile}_${targetSym}`,
          kind: "references",
          confidence: "high",
        });
      }
      for (let ss = 0; ss < SYMBOLS_PER_FILE; ss++) {
        syms.push({
          id: `sym_${f}_${ss}`,
          kind: "function",
          name: `func_${f}_${ss}`,
          file_path: `src/file_${f}.ts`,
        });
      }
    }
    s.insertEdges(edges);
    s.upsertSymbols(syms);
  }

  // transaction()
  store.clearAllEdges();
  store.clearAllSymbols();
  const t1 = process.hrtime();
  store.transaction(() => seedEdgesAndSymbols(store));
  const ms1 = hrMs(t1);

  // bulkTransaction()
  store.clearAllEdges();
  store.clearAllSymbols();
  const t2 = process.hrtime();
  store.bulkTransaction(() => seedEdgesAndSymbols(store));
  const ms2 = hrMs(t2);

  console.log(`  transaction()     (${TOTAL_EDGES} edges + ${TOTAL_SYMBOLS} syms): ${fmt(ms1)}`);
  console.log(`  bulkTransaction() (${TOTAL_EDGES} edges + ${TOTAL_SYMBOLS} syms): ${fmt(ms2)}`);
  console.log(`  Speedup: ${(ms1 / ms2).toFixed(1)}x`);
}

// ── Cleanup ──────────────────────────────────────────────────────────

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${"─".repeat(60)}`);
console.log("  Done.");
console.log(`${"─".repeat(60)}\n`);
