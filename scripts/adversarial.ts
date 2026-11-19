/**
 * Worst-case inputs for each algorithm, timed against git.
 *
 *   node scripts/adversarial.ts [lines]
 *
 * Every measurement runs in its own process with a time limit, so a
 * pathological case shows up as a timeout instead of a hang.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = Number(process.argv[2] ?? 50_000);
const LIMIT_MS = 60_000;

const lines = (xs: (string | number)[]) => xs.map((x) => `${x}\n`).join('');
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Each case: [name, old, new]. */
const cases: [string, string, string][] = [
  // Unique lines in reverse order: no common subsequence longer than one.
  ['reversed unique lines', lines(range(N)), lines(range(N).reverse())],
  // Adjacent pairs swapped: every anchor peels off only two lines.
  ['swapped pairs', lines(range(N)), lines(range(N).map((i) => (i % 2 ? i - 1 : i + 1)))],
  // Two distinct lines in random order on both sides: maximal ambiguity.
  ['two-line alphabet', lines(range(N).map((i) => (Math.imul(i, 2654435761) >>> 31 ? 'a' : 'b'))), lines(range(N).map((i) => (Math.imul(i + 7, 2246822519) >>> 31 ? 'a' : 'b')))],
  // Lines repeated just below histogram's occurrence limit (64).
  ['64-fold repeats, shuffled', lines(range(N).map((i) => i % (N / 64))), lines(range(N).map((i) => (Math.imul(i, 40503) >>> 0) % (N / 64)))],
  // Interleaved: every other line differs.
  ['every other line changed', lines(range(N)), lines(range(N).map((i) => (i % 2 ? `x${i}` : i)))],
  // No line in common at all.
  ['nothing in common', lines(range(N)), lines(range(N).map((i) => `y${i}`))],
  // One enormous line on each side.
  ['one 10 MB line', 'a'.repeat(10_000_000) + '\n', 'a'.repeat(9_999_999) + 'b\n'],
];

const dir = mkdtempSync(join(tmpdir(), 'hunks-adversarial-'));
const runner = join(dir, 'run.mjs');
writeFileSync(runner, `
import { readFileSync } from 'node:fs';
import { patch } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'index.ts'))};
const [a, b, algorithm] = process.argv.slice(2);
const t = performance.now();
patch(readFileSync(a), readFileSync(b), { algorithm });
console.log(performance.now() - t);
`);

function time(cmd: string, args: string[]): string {
  const t = performance.now();
  const r = spawnSync(cmd, args, { timeout: LIMIT_MS, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.signal) return `> ${LIMIT_MS / 1000} s`;
  if (r.status !== 0 && r.status !== 1) return `error: ${r.stderr.toString().slice(0, 80)}`;
  const ms = cmd === process.execPath ? Number(r.stdout.toString().trim()) : performance.now() - t;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`;
}

console.log(`${N.toLocaleString('en')} lines per side\n`);
console.log('case'.padEnd(28) + ['myers', 'minimal', 'patience', 'histogram'].map((a) => `${a} (hunks / git)`.padEnd(26)).join(''));
for (const [name, a, b] of cases) {
  const fa = join(dir, 'a');
  const fb = join(dir, 'b');
  writeFileSync(fa, a);
  writeFileSync(fb, b);
  let row = name.padEnd(28);
  for (const algorithm of ['myers', 'minimal', 'patience', 'histogram']) {
    const ours = time(process.execPath, [runner, fa, fb, algorithm]);
    const git = time('git', ['diff', '--no-index', `--diff-algorithm=${algorithm}`, '--no-color', fa, fb]);
    row += `${ours} / ${git}`.padEnd(26);
  }
  console.log(row);
}
rmSync(dir, { recursive: true, force: true });
