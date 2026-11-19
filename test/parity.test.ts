/**
 * Byte-for-byte comparison with the git binary on this machine.
 * Skipped when git is not installed.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import type { PatchOptions } from '../src/index.ts';
import { fuzzCase, rng } from './fuzz.ts';
import { compare } from './git.ts';

const hasGit = spawnSync('git', ['--version']).status === 0;
const enc = new TextEncoder();

function same(a: string | Uint8Array, b: string | Uint8Array, options: PatchOptions = {}): void {
  const m = compare(typeof a === 'string' ? enc.encode(a) : a, typeof b === 'string' ? enc.encode(b) : b, options);
  if (m) assert.equal(m.actual, m.expected, `differs from git ${m.flags.join(' ')}`);
}

const ALL: PatchOptions[] = [
  {},
  { algorithm: 'minimal' },
  { algorithm: 'patience' },
  { algorithm: 'histogram' },
  { indentHeuristic: false },
  { context: 0 },
  { functionContext: true },
];

describe('parity with git', { skip: !hasGit && 'git not installed' }, () => {
  test('randomised cases (fixed seeds)', () => {
    const failures: number[] = [];
    for (let seed = 1; seed <= 1500; seed++) if (fuzzCase(seed)) failures.push(seed);
    assert.deepEqual(failures, [], `run "node test/fuzz.ts 1 <seed>" to reproduce`);
  });

  test('sliders land where git puts them', () => {
    const a = 'if (x) {\n  foo();\n}\nbaz();\n';
    const b = 'if (x) {\n  foo();\n}\nif (y) {\n  bar();\n}\nbaz();\n';
    for (const o of ALL) same(a, b, o);
    const c = 'class A:\n    def a(self):\n        pass\n\n    def c(self):\n        pass\n';
    const d = 'class A:\n    def a(self):\n        pass\n\n    def b(self):\n        pass\n\n    def c(self):\n        pass\n';
    for (const o of ALL) same(c, d, o);
  });

  test('line endings and the final newline', () => {
    for (const o of ALL) {
      same('a\nb', 'a\nb\n', o);
      same('a\nb\n', 'a\nb', o);
      same('a\nb', 'a\nc', o);
      same('a\r\nb\r\n', 'a\nb\n', o);
      same('a\r\nb\r\n', 'a\nb\n', { ...o, ignoreCrAtEol: true });
      same('x\r', 'x', { ...o, ignoreCrAtEol: true });
      same('', 'a\n', o);
      same('a\n', '', o);
    }
  });

  test('function names cut at 80 bytes, on a valid UTF-8 boundary', () => {
    const body = Array.from({ length: 10 }, (_, i) => `  line${i}\n`).join('');
    const changed = body.replace('line8', 'LINE8');
    for (const prefix of ['function ', 'function x', 'function xy']) {
      const head = prefix + '\u00e9'.repeat(40) + '() {\n';
      same(head + body, head + changed);
    }
    same('g'.repeat(100) + '\n' + body, 'g'.repeat(100) + '\n' + changed);
    same('h'.repeat(79) + '  x\n' + body, 'h'.repeat(79) + '  x\n' + changed);
    const latin1 = new Uint8Array([...enc.encode('caf'), 0xe9, ...enc.encode('()\n' + body)]);
    const latin1b = new Uint8Array([...enc.encode('caf'), 0xe9, ...enc.encode('()\n' + changed)]);
    same(latin1, latin1b);
    same('nonchar \uFFFE here\n' + body, 'nonchar \uFFFE here\n' + changed);
  });

  test('--ignore-blank-lines counts a lone final byte as blank', () => {
    same('a\nb\nc\n\nx', 'a\nb\nc\n\ny', { ignoreBlankLines: true });
    same('a\nb\n\n\nc\n', 'a\nb\nc\n', { ignoreBlankLines: true, context: 0 });
    same('a\n\nb\n\n\nc\nd\ne\nf\ng\nh\n', 'a\nb\n\nc\nd\ne\nF\ng\nh\n', { ignoreBlankLines: true });
  });

  test('-U0 trims the common tail in 1 KiB blocks first', () => {
    const tail = Array.from({ length: 400 }, (_, i) => (i % 7 === 0 ? '}\n' : `  item${i % 13}();\n`)).join('');
    const a = 'x\n}\n' + tail;
    const b = 'x\n}\n}\n' + tail;
    for (const algorithm of ['myers', 'patience', 'histogram'] as const) same(a, b, { algorithm, context: 0 });
  });

  test('function context', () => {
    const src = (n: number) =>
      Array.from({ length: n }, (_, f) => `function f${f}() {\n  a();\n\n  b();\n}\n\n`).join('');
    const a = src(6);
    same(a, a.replace('function f3() {\n  a();', 'function f3() {\n  A();'), { functionContext: true });
    same(a, a + 'function g() {\n  c();\n}\n', { functionContext: true });
    same(a, a + 'trailing();\n', { functionContext: true });
  });

  test('anchored lines', () => {
    const a = 'a\nb\nc\nd\ne\n';
    const b = 'c\nd\ne\na\nb\n';
    same(a, b, { anchored: 'c' });
    same(a, b, { anchored: ['a', 'b'] });
    same(a, b, { anchored: 'c', algorithm: 'minimal' });
  });

  test('large inputs that hit the cost limits', () => {
    const r = rng(42);
    const words = ['alpha', 'beta', 'gamma', 'delta', '}', '', '  return;', 'x++;'];
    const make = (n: number) => Array.from({ length: n }, () => words[Math.floor(r() * words.length)] + (r() < 0.3 ? ` ${Math.floor(r() * 50)}` : '')).join('\n') + '\n';
    const a = make(6000);
    const lines = a.split('\n');
    for (let i = 0; i < 1500; i++) lines[Math.floor(r() * lines.length)] = `changed ${i}`;
    const b = lines.join('\n');
    for (const o of [{}, { algorithm: 'histogram' as const }, { algorithm: 'patience' as const }, { context: 0 }]) same(a, b, o);
  });

  test('long unchanged runs between sparse changes (the "good snake" exit)', () => {
    // Shaped so that Myers' early exit on a long diagonal actually fires:
    // the inputs must be large enough (~65k lines in total) for the cost cap
    // to exceed 256, and changed lines must have partners on the other side,
    // or the discard pass removes them before the search starts.
    const r = rng(13);
    const keep = (k: number) => Array.from({ length: 100 }, (_, i) => `stable ${k} ${i}\n`).join('');
    const churn = () => Array.from({ length: 4 }, () => `noise ${Math.floor(r() * 3000)}\n`).join('');
    let a = '';
    let b = '';
    for (let k = 0; k < 400; k++) {
      a += keep(k) + churn();
      b += keep(k) + churn();
    }
    for (const o of [{}, { algorithm: 'histogram' as const }, { context: 0 }, { indentHeuristic: false }]) same(a, b, o);
  });
});
