import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DiffTimeoutError, merge, type MergeOptions } from '../src/index.ts';
import { gitVersion } from './git.ts';
import { checkCase, generateCase } from './merge-fuzz.ts';

// Expected outputs in this file were produced by `git merge-file -p`.
const base = 'one\ntwo\nthree\nfour\nfive\n';
const ours = 'one\nTWO\nthree\nfour\nfive\n';
const theirs = 'one\n2\nthree\nfour\nfive\n';
const labels = { ours: 'mine', base: 'base', theirs: 'yours' };

describe('merge', () => {
  test('takes changes that do not overlap from both sides', () => {
    assert.deepEqual(merge('ONE\ntwo\nthree\nfour\nfive\n', base, 'one\ntwo\nthree\nfour\nFIVE\n'), {
      merged: 'ONE\ntwo\nthree\nfour\nFIVE\n',
      conflicts: 0,
    });
  });

  test('marks overlapping changes as a conflict', () => {
    assert.deepEqual(merge(ours, base, theirs, { labels }), {
      merged: 'one\n<<<<<<< mine\nTWO\n=======\n2\n>>>>>>> yours\nthree\nfour\nfive\n',
      conflicts: 1,
    });
  });

  test('without labels, the markers stand alone', () => {
    assert.equal(merge(ours, base, theirs).merged, 'one\n<<<<<<<\nTWO\n=======\n2\n>>>>>>>\nthree\nfour\nfive\n');
  });

  test('diff3 and zdiff3 show the base', () => {
    const expected = 'one\n<<<<<<< mine\nTWO\n||||||| base\ntwo\n=======\n2\n>>>>>>> yours\nthree\nfour\nfive\n';
    assert.equal(merge(ours, base, theirs, { labels, style: 'diff3' }).merged, expected);
    assert.equal(merge(ours, base, theirs, { labels, style: 'zdiff3' }).merged, expected);
  });

  test('lines both sides added leave the conflict, except with diff3', () => {
    const o = 'one\nshared\nTWO\nthree\nfour\nfive\n';
    const t = 'one\nshared\n2\nthree\nfour\nfive\n';
    const l = { ours: 'o', base: 'b', theirs: 't' };
    assert.equal(merge(o, base, t, { labels: l }).merged, 'one\nshared\n<<<<<<< o\nTWO\n=======\n2\n>>>>>>> t\nthree\nfour\nfive\n');
    assert.equal(merge(o, base, t, { labels: l, style: 'zdiff3' }).merged, 'one\nshared\n<<<<<<< o\nTWO\n||||||| b\ntwo\n=======\n2\n>>>>>>> t\nthree\nfour\nfive\n');
    assert.equal(merge(o, base, t, { labels: l, style: 'diff3' }).merged, 'one\n<<<<<<< o\nshared\nTWO\n||||||| b\ntwo\n=======\nshared\n2\n>>>>>>> t\nthree\nfour\nfive\n');
  });

  test('the same change on both sides is no conflict', () => {
    assert.deepEqual(merge(ours, base, ours), { merged: ours, conflicts: 0 });
  });

  test('favor settles every conflict', () => {
    assert.deepEqual(merge(ours, base, theirs, { favor: 'ours' }), { merged: ours, conflicts: 0 });
    assert.deepEqual(merge(ours, base, theirs, { favor: 'theirs' }), { merged: theirs, conflicts: 0 });
    assert.deepEqual(merge(ours, base, theirs, { favor: 'union' }), { merged: 'one\nTWO\n2\nthree\nfour\nfive\n', conflicts: 0 });
  });

  test('marker size', () => {
    assert.equal(merge(ours, base, theirs, { labels, markerSize: 3 }).merged, 'one\n<<< mine\nTWO\n===\n2\n>>> yours\nthree\nfour\nfive\n');
  });

  test('git merge-file joins conflicts across lines with no letter or digit; git merge does not', () => {
    const b = 'a\n}\n}\n}\n}\nc\n';
    const o = 'A\n}\n}\n}\n}\nC\n';
    const t = 'a1\n}\n}\n}\n}\nc1\n';
    const l = { ours: 'o', base: 'b', theirs: 't' };
    assert.deepEqual(merge(o, b, t, { labels: l }), { merged: '<<<<<<< o\nA\n}\n}\n}\n}\nC\n=======\na1\n}\n}\n}\n}\nc1\n>>>>>>> t\n', conflicts: 1 });
    assert.equal(merge(o, b, t, { labels: l, level: 'zealous' }).conflicts, 2);
  });

  test('markers follow CRLF line endings', () => {
    const r = merge('one\r\nTWO\r\nthree\r\n', 'one\r\ntwo\r\nthree\r\n', 'one\r\n2\r\nthree\r\n', { labels: { ours: 'o', theirs: 't' } });
    assert.equal(r.merged, 'one\r\n<<<<<<< o\r\nTWO\r\n=======\r\n2\r\n>>>>>>> t\r\nthree\r\n');
  });

  test('when one side changed nothing, the other side is the result as it is', () => {
    const spaced = 'one \ntwo\nthree\nfour\nfive\n';
    // Under -b, ours differs from the base only in whitespace: theirs wins, byte for byte.
    assert.equal(merge(spaced, base, theirs, { ignoreWhitespaceChange: true }).merged, theirs);
    assert.equal(merge(base, base, theirs).merged, theirs);
  });

  test('bytes in, bytes out', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const r = merge(enc(ours), enc(base), enc(theirs), { labels: { ours: 'café' } });
    assert.ok(r.merged instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(r.merged), 'one\n<<<<<<< café\nTWO\n=======\n2\n>>>>>>>\nthree\nfour\nfive\n');
    assert.equal(r.conflicts, 1);
  });

  test('an empty label leaves no space after the marker in git 2.55 and later', () => {
    const merged = merge(ours, base, theirs, { labels: { ours: '' } }).merged;
    assert.equal(merged.split('\n')[1], gitVersion >= 255 ? '<<<<<<<' : '<<<<<<< ');
  });

  test('rejects options it cannot honour', () => {
    const bad: [MergeOptions, RegExp][] = [
      [{ labels: { ours: 'a\nb' } }, /labels.ours cannot contain a line break/],
      [{ labels: { theirs: 'a\rb' } }, /labels.theirs cannot contain a line break/],
      // @ts-expect-error: deliberately wrong
      [{ labels: { base: 1 } }, /labels.base must be a string/],
      // @ts-expect-error: deliberately wrong
      [{ style: 'diff4' }, /style must be 'merge', 'diff3', 'zdiff3', got 'diff4'/],
      // @ts-expect-error: deliberately wrong
      [{ favor: 'mine' }, /favor must be 'ours', 'theirs', 'union'/],
      // @ts-expect-error: deliberately wrong
      [{ level: 'max' }, /level must be 'minimal', 'eager', 'zealous', 'zealous-alnum'/],
      [{ markerSize: 0 }, /markerSize must be at least 1/],
      [{ markerSize: 2.5 }, /markerSize must be a non-negative integer/],
      // @ts-expect-error: deliberately wrong
      [{ algorithm: 'fast' }, /unknown algorithm 'fast'/],
    ];
    for (const [options, message] of bad) assert.throws(() => merge(ours, base, theirs, options), message);
    // @ts-expect-error: deliberately wrong
    assert.throws(() => merge(ours, null, theirs), /the base text must be a string or a Uint8Array/);
  });

  test('timeout', () => {
    const n = 30_000;
    const lines = (f: (i: number) => number) => Array.from({ length: n }, (_, i) => `${f(i)}\n`).join('');
    const b = lines((i) => i);
    const o = lines((i) => (i % 2 ? i - 1 : i + 1));
    const t = lines((i) => (i % 3 ? i : -i));
    assert.throws(() => merge(o, b, t, { algorithm: 'histogram', timeout: 1 }), DiffTimeoutError);
  });
});

describe('merge parity with git', () => {
  test('300 generated merges are byte for byte what git merge-file and git merge produce', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const c = generateCase(seed);
      const mismatch = checkCase(c);
      assert.equal(mismatch, null, `seed ${seed} (${c.harness}, ${JSON.stringify(c.options)})`);
    }
  });
});
