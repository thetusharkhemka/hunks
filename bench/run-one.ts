/**
 * Time one library on one file pair; prints a JSON line. Run by bench.ts in
 * a fresh process per measurement, so a slow library cannot stall the run
 * and every library gets its own JIT warm-up.
 *
 *   node bench/run-one.ts <library> <old-file> <new-file>
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { edits, patch } from '../src/index.ts';

const require = createRequire(import.meta.url);
const [lib, fileA, fileB] = process.argv.slice(2);
const a = readFileSync(fileA, 'utf8');
const b = readFileSync(fileB, 'utf8');

function intern(x: string[], y: string[]): [Int32Array, Int32Array] {
  const map = new Map<string, number>();
  const id = (s: string) => {
    let v = map.get(s);
    if (v === undefined) map.set(s, (v = map.size));
    return v;
  };
  return [Int32Array.from(x, id), Int32Array.from(y, id)];
}

const libraries: Record<string, () => Promise<() => unknown>> = {
  async 'hunks'() {
    return () => patch(a, b);
  },
  async 'hunks (histogram)'() {
    return () => patch(a, b, { algorithm: 'histogram' });
  },
  async 'hunks edits()'() {
    return () => edits(a, b);
  },
  async 'diff (jsdiff)'() {
    const { structuredPatch } = require('diff');
    return () => structuredPatch('a', 'b', a, b, '', '', { context: 3 });
  },
  async '@jest/diff-sequences'() {
    const diffSequences = require('@jest/diff-sequences').default;
    return () => {
      const [x, y] = intern(a.split('\n'), b.split('\n'));
      let n = 0;
      diffSequences(x.length, y.length, (i: number, j: number) => x[i] === y[j], () => n++);
      return n;
    };
  },
  async 'fast-myers-diff'() {
    const { diff } = await import('fast-myers-diff');
    return () => {
      const [x, y] = intern(a.split('\n'), b.split('\n'));
      return [...diff(x, y)].length;
    };
  },
  async 'diff-match-patch'() {
    const DMP = require('diff-match-patch');
    return () => {
      const dmp = new DMP();
      dmp.Diff_Timeout = 0;
      const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
      const diffs = dmp.diff_main(chars1, chars2, false);
      dmp.diff_charsToLines_(diffs, lineArray);
      return diffs.length;
    };
  },
  async 'vscode-diff'() {
    const { DefaultLinesDiffComputer } = require('vscode-diff');
    const al = a.split('\n');
    const bl = b.split('\n');
    return () => new DefaultLinesDiffComputer().computeDiff(al, bl, { ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: 0 });
  },
  async '@vscode/diff'() {
    // Its WebAssembly backend panics in 0.0.2-0; the TypeScript one works.
    const { createDiffComputer } = await import('@vscode/diff');
    const computer = await createDiffComputer({ useWasm: false });
    const options = { ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: 0, extendToSubwords: false };
    return () => computer.computeDiff(a, b, options);
  },
};

const setup = libraries[lib];
if (!setup) throw new Error(`unknown library ${lib}`);
const fn = await setup();

// Warm up, then time until we have enough samples or enough time has passed.
const first = performance.now();
fn();
const firstMs = performance.now() - first;
const samples: number[] = [firstMs];
const budget = 3000;
const started = performance.now();
while (samples.length < 15 && performance.now() - started < budget) {
  const t = performance.now();
  fn();
  samples.push(performance.now() - t);
}
samples.sort((x, y) => x - y);
console.log(JSON.stringify({ lib, median: samples[samples.length >> 1], min: samples[0], runs: samples.length }));
