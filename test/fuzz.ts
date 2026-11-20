/**
 * Differential fuzzing against git.
 *
 * Generates file pairs that are hostile in the ways that matter to a diff
 * engine (heavy duplication, sliding blocks, whitespace variants, CRLF,
 * missing final newlines, invalid and multibyte UTF-8 near the 80-byte
 * header limit) together with random option sets, and checks that the
 * output is byte-identical to `git diff --no-index`.
 *
 *   node test/fuzz.ts [iterations] [seed]
 */

import type { PatchOptions } from '../src/index.ts';
import { compare, type Mismatch } from './git.ts';

/** Small, fast, seedable PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const enc = new TextEncoder();
const bytes = (...parts: (string | number[])[]): number[] =>
  parts.flatMap((p) => (typeof p === 'string' ? [...enc.encode(p)] : p));

/** Building blocks for lines. Mostly code-like, some deliberately nasty. */
const VOCABULARY: number[][] = [
  bytes(''), bytes(''), bytes(''),
  bytes('}'), bytes('  }'), bytes('    }'), bytes('\t}'),
  bytes('{'), bytes('  {'),
  bytes('function parse(input) {'), bytes('function render(node) {'),
  bytes('  return x;'), bytes('  return null;'), bytes('    return y;'),
  bytes('  if (a) {'), bytes('  } else {'), bytes('    i++;'),
  bytes('def run(self):'), bytes('    pass'), bytes('class Config:'),
  bytes('x = 1'), bytes('x  = 1'), bytes('x = 1 '), bytes('x\t= 1'), bytes(' x = 1'),
  bytes('  '), bytes('\t'), bytes(' \t '),
  bytes('// comment'), bytes('  // note'), bytes('# heading'),
  bytes('_private()'), bytes('$var = 2'), bytes('9 lives'),
  bytes('café ' + 'x'.repeat(10)),
  bytes('function ' + 'é'.repeat(40) + '() {'),
  bytes('f' + 'x'.repeat(78), [0xc3, 0xa9], 'tail'),
  bytes('g' + 'y'.repeat(79), [0xe9], 'latin1'),
  bytes('h' + 'z'.repeat(40), [0xef, 0xbf, 0xbe], 'nonchar'),
  bytes('k', [0xff, 0xfe], ' bytes'),
  bytes('L' + 'w'.repeat(120) + '  '),
  bytes('emoji \u{1f600} line'),
  bytes('a'), bytes('b'), bytes('c'), bytes('d'),
];

export interface Doc {
  lines: number[][];
  crlf: boolean[];
}

export function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

function randomLine(r: () => number): number[] {
  return [...pick(r, VOCABULARY)];
}

export function generate(r: () => number): Doc {
  const n = r() < 0.05 ? 0 : Math.floor(r() * (r() < 0.2 ? 400 : 60));
  // A small palette makes duplicates likely.
  const palette = Array.from({ length: 1 + Math.floor(r() * 25) }, () => randomLine(r));
  const lines = Array.from({ length: n }, () => [...pick(r, palette)]);
  return { lines, crlf: lines.map(() => r() < 0.08) };
}

export function mutate(r: () => number, doc: Doc): Doc {
  const lines = doc.lines.map((l) => [...l]);
  const crlf = [...doc.crlf];
  const ops = 1 + Math.floor(r() * 6);
  for (let k = 0; k < ops; k++) {
    const at = Math.floor(r() * (lines.length + 1));
    const len = 1 + Math.floor(r() * 6);
    const op = r();
    if (op < 0.25) {
      // Insert a copy of nearby lines: the classic slider.
      const from = Math.max(0, at - len);
      const block = lines.slice(from, at).map((l) => [...l]);
      lines.splice(at, 0, ...(block.length ? block : [randomLine(r)]));
      crlf.splice(at, 0, ...(block.length ? block : [0]).map(() => r() < 0.08));
    } else if (op < 0.45) {
      const block = Array.from({ length: len }, () => randomLine(r));
      lines.splice(at, 0, ...block);
      crlf.splice(at, 0, ...block.map(() => r() < 0.08));
    } else if (op < 0.65) {
      lines.splice(at, len);
      crlf.splice(at, len);
    } else if (op < 0.8 && lines.length > 0) {
      const i = Math.min(at, lines.length - 1);
      lines[i] = randomLine(r);
    } else if (op < 0.9 && lines.length > 1) {
      // Move a block.
      const block = lines.splice(at, len);
      const flags = crlf.splice(at, len);
      const to = Math.floor(r() * (lines.length + 1));
      lines.splice(to, 0, ...block);
      crlf.splice(to, 0, ...flags);
    } else if (lines.length > 0) {
      // Whitespace-only edit.
      const i = Math.min(at, lines.length - 1);
      const l = lines[i];
      const choice = r();
      if (choice < 0.33) lines[i] = [32, ...l];
      else if (choice < 0.66) lines[i] = [...l, 32];
      else lines[i] = l.map((c) => (c === 32 ? 9 : c));
    }
  }
  return { lines, crlf };
}

export function render(doc: Doc, finalNewline: boolean): Uint8Array {
  const out: number[] = [];
  doc.lines.forEach((l, i) => {
    out.push(...l);
    if (i < doc.lines.length - 1 || finalNewline) {
      if (doc.crlf[i]) out.push(13);
      out.push(10);
    }
  });
  return new Uint8Array(out);
}

const IGNORE_PATTERNS = [new RegExp('^[ \t]*//'), new RegExp('^[ \t]*}$'), new RegExp('return')];

function randomOptions(r: () => number, a: Doc): PatchOptions {
  const o: PatchOptions = {};
  const alg = r();
  if (alg < 0.25) o.algorithm = 'histogram';
  else if (alg < 0.45) o.algorithm = 'patience';
  else if (alg < 0.55) o.algorithm = 'minimal';
  else if (alg < 0.7) o.algorithm = 'myers';
  if (r() < 0.2) o.indentHeuristic = false;
  const u = r();
  if (u < 0.25) o.context = 0;
  else if (u < 0.4) o.context = 1;
  else if (u < 0.5) o.context = Math.floor(r() * 8);
  if (r() < 0.15) o.interHunkContext = Math.floor(r() * 4);
  if (r() < 0.12) o.functionContext = true;
  if (r() < 0.12) o.ignoreWhitespace = true;
  if (r() < 0.12) o.ignoreWhitespaceChange = true;
  if (r() < 0.12) o.ignoreWhitespaceAtEol = true;
  if (r() < 0.12) o.ignoreCrAtEol = true;
  if (r() < 0.15) o.ignoreBlankLines = true;
  if (r() < 0.08) o.ignoreMatchingLines = pick(r, IGNORE_PATTERNS);
  if (r() < 0.06 && a.lines.length > 0) {
    const line = pick(r, a.lines).filter((c) => c < 0x80 && c !== 0x27);
    const text = String.fromCharCode(...line.slice(0, 1 + Math.floor(r() * 6)));
    if (text.trim() && !text.startsWith('-')) o.anchored = text;
  }
  return o;
}

export interface FuzzResult {
  seed: number;
  options: PatchOptions;
  a: Uint8Array;
  b: Uint8Array;
  mismatch: Mismatch;
}

/** Run one fuzz case; returns the failure, if any. */
export function fuzzCase(seed: number): FuzzResult | null {
  const r = rng(seed);
  const docA = generate(r);
  const docB = mutate(r, docA);
  const a = render(docA, r() > 0.15);
  const b = render(docB, r() > 0.15);
  const options = randomOptions(r, docA);
  const mismatch = compare(a, b, options);
  return mismatch ? { seed, options, a, b, mismatch } : null;
}

if (import.meta.main) {
  const iterations = Number(process.argv[2] ?? 2000);
  const start = Number(process.argv[3] ?? Date.now() % 1e9);
  let failures = 0;
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const seed = start + i;
    const f = fuzzCase(seed);
    if (!f) continue;
    failures++;
    if (failures <= 3) {
      console.log(`\nseed ${seed}  options ${JSON.stringify(f.options, (_, v) => (v instanceof RegExp ? String(v) : v))}`);
      const e = f.mismatch.expected.split('\n');
      const x = f.mismatch.actual.split('\n');
      let k = 0;
      while (k < e.length && e[k] === x[k]) k++;
      console.log(`  first difference at output line ${k + 1}`);
      console.log('  git:   ' + JSON.stringify(e.slice(Math.max(0, k - 3), k + 4)));
      console.log('  hunks: ' + JSON.stringify(x.slice(Math.max(0, k - 3), k + 4)));
    }
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\n${iterations - failures}/${iterations} cases identical to git (seeds ${start}..${start + iterations - 1}) in ${secs}s`);
  process.exitCode = failures ? 1 : 0;
}
