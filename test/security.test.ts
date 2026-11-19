/**
 * Hostile input: things that must not be able to forge output, hang the
 * process, drive a terminal or hide text. Where git defines the behaviour,
 * the expected output comes from the git binary.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { after, describe, test } from 'node:test';
import { diff, diffArrays, DiffTimeoutError, edits, inline, patch } from '../src/index.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const dir = mkdtempSync(join(tmpdir(), 'hunks-security-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b);

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };

function git(args: string[], options: { cwd?: string; input?: string } = {}) {
  return spawnSync('git', ['diff', '--no-index', '--no-color', ...args], { ...options, env: gitEnv, maxBuffer: 1 << 30 });
}

function hunks(args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { ...options, env: options.env ?? gitEnv, maxBuffer: 1 << 30 });
}

/**
 * Adjacent lines swapped: every anchor histogram finds peels off only two
 * lines, so it does quadratic work, in git as here. Minimal is slow on it too.
 */
function quadraticForHistogram(n: number): [string, string] {
  const a = Array.from({ length: n }, (_, i) => `${i}\n`).join('');
  const b = Array.from({ length: n }, (_, i) => `${i % 2 ? i - 1 : i + 1}\n`).join('');
  return [a, b];
}

describe('patch labels', () => {
  test('are quoted exactly as git quotes paths', () => {
    const names = ['café.txt', 'with space.txt', 'quote".txt', 'back\\slash.txt', 'new\nline.txt', 'tab\there.txt', 'bell\x07.txt', 'esc\x1b[31m.txt', '‮evil.txt', 'plain.txt'];
    for (const name of names) {
      const where = mkdtempSync(join(dir, 'labels-'));
      mkdirSync(join(where, 'old'));
      mkdirSync(join(where, 'new'));
      writeFileSync(join(where, 'old', name), 'a\n');
      writeFileSync(join(where, 'new', name), 'b\n');
      const out = git([join('old', name), join('new', name)], { cwd: where }).stdout.toString();
      const expected = out.split('\n').filter((l) => l.startsWith('--- ') || l.startsWith('+++ '));
      const ours = patch('a\n', 'b\n', { fromFile: `a/old/${name}`, toFile: `b/new/${name}` }).split('\n').slice(0, 2);
      assert.deepEqual(ours, expected, JSON.stringify(name));
    }
  });

  test('cannot add lines to the patch', () => {
    const forged = 'x\n+++ b/evil\n@@ -1 +1 @@\n-a\n+pwned';
    const out = patch('a\n', 'b\n', { fromFile: forged, toFile: forged });
    assert.equal(out.split('\n').length, 6);
    // Quoted, and with git's tab after a name that contains a space.
    assert.ok(out.startsWith('--- "x\\n+++ b/evil\\n@@ -1 +1 @@\\n-a\\n+pwned"\t\n'));
  });

  test('must be strings', () => {
    // @ts-expect-error: deliberately wrong
    assert.throws(() => patch('a\n', 'b\n', { fromFile: 42 }), TypeError);
  });
});

describe('options', () => {
  test('must be an object', () => {
    for (const bad of [null, 5, 'x']) {
      // @ts-expect-error: deliberately wrong
      assert.throws(() => patch('a\n', 'b\n', bad), /options must be an object/);
      // @ts-expect-error: deliberately wrong
      assert.throws(() => edits('a\n', 'b\n', bad), /options must be an object/);
      // @ts-expect-error: deliberately wrong
      assert.throws(() => diffArrays([1], [2], bad), /options must be an object/);
      // @ts-expect-error: deliberately wrong
      assert.throws(() => inline(['a'], ['b'], bad), /options must be an object/);
    }
  });

  test('huge context values are clamped, not looped over', () => {
    const a = 'x\n'.repeat(5) + 'a\n' + 'y\n'.repeat(5);
    const b = 'x\n'.repeat(5) + 'b\n' + 'y\n'.repeat(5);
    assert.match(patch(a, b, { context: Number.MAX_SAFE_INTEGER, interHunkContext: Number.MAX_SAFE_INTEGER }), /^@@ -1,11 \+1,11 @@\n/);
  });
});

describe('hunk headings', () => {
  const a = 'head\n1\n2\n3\n4\na\n';
  const b = 'head\n1\n2\n3\n4\nb\n';

  test('a funcname function cannot break the header line', () => {
    const out = patch(a, b, { funcname: () => 'f\n+++ b/evil\n@@ -1 +1 @@' });
    assert.equal(out.split('\n')[0], '@@ -3,4 +3,4 @@ f');
    assert.equal(out.split('\n').length, 7);
  });

  test('a funcname pattern sees one line at a time, the nearest match above the hunk', () => {
    assert.equal(patch(a, b, { funcname: /[\s\S]*/ }).split('\n')[0], '@@ -3,4 +3,4 @@ 1');
    assert.equal(patch(a, b, { funcname: /^h.*/ }).split('\n')[0], '@@ -3,4 +3,4 @@ head');
  });

  test('a byte order mark is kept, in text and byte mode alike', () => {
    const x = '﻿head\n1\n2\n3\n4\na\n';
    const y = '﻿head\n1\n2\n3\n4\nb\n';
    const options = { funcname: /^\ufeffhead$/ };
    assert.equal(patch(x, y, options).split('\n')[0], '@@ -3,4 +3,4 @@ ﻿head');
    assert.equal(dec(patch(enc(x), enc(y), options)), patch(x, y, options));
  });
});

describe('timeout', () => {
  test('stops histogram on input crafted to be quadratic', () => {
    const [a, b] = quadraticForHistogram(40_000);
    const start = performance.now();
    assert.throws(() => patch(a, b, { algorithm: 'histogram', timeout: 50 }), (err: unknown) => {
      assert.ok(err instanceof DiffTimeoutError);
      assert.equal(err.timeout, 50);
      assert.equal(err.name, 'DiffTimeoutError');
      return true;
    });
    assert.ok(performance.now() - start < 2000, 'gave up promptly');
  });

  test('covers minimal, the inline pass, edits and diffArrays', () => {
    const [a, b] = quadraticForHistogram(40_000);
    assert.throws(() => patch(a, b, { algorithm: 'minimal', timeout: 1 }), DiffTimeoutError);
    assert.throws(() => edits(a, b, { algorithm: 'histogram', timeout: 1 }), DiffTimeoutError);
    assert.throws(() => diff(a, b, { algorithm: 'histogram', timeout: 1, inline: true }), DiffTimeoutError);
    const xs = a.split('\n');
    assert.throws(() => diffArrays(xs, xs.slice().reverse(), { algorithm: 'histogram', timeout: 1 }), DiffTimeoutError);
  });

  test('does not change the result when it is not reached', () => {
    const [a, b] = quadraticForHistogram(300);
    assert.equal(patch(a, b, { algorithm: 'histogram', timeout: 60_000 }), patch(a, b, { algorithm: 'histogram' }));
    assert.equal(patch(a, b, { timeout: Infinity }), patch(a, b));
  });

  test('must be a positive number', () => {
    for (const timeout of [0, -1, NaN, '5', null]) {
      // @ts-expect-error: deliberately wrong for some
      assert.throws(() => patch('a\n', 'b\n', { timeout }), RangeError, String(timeout));
    }
    assert.throws(() => inline(['a'], ['b'], { timeout: -1 }), RangeError);
  });
});

describe('bytes', () => {
  test('diff() compares bytes exactly, as patch() does', () => {
    // A byte order mark that appears, and two different invalid bytes,
    // would both vanish if the bytes were decoded before comparing.
    const bom = diff(enc('a\n'), enc('﻿a\n'));
    assert.deepEqual(bom.hunks[0].lines.map((l) => [l.type, l.text]), [['removed', 'a'], ['added', '﻿a']]);
    const invalid = diff(new Uint8Array([0x61, 0xff, 0x0a]), new Uint8Array([0x61, 0xfe, 0x0a]));
    assert.deepEqual(invalid.hunks[0].lines.map((l) => [l.type, l.text]), [['removed', 'a�'], ['added', 'a�']]);
  });

  test('diff() hunks match patch() hunks for bytes', () => {
    const a = enc('fn é()\n  1\n  2\n  3\n  4\n  5\n  six\n');
    const b = enc('fn é()\n  1\n  2\n  3\n  4\n  5\n  SIX\n');
    const headers = dec(patch(a, b)).split('\n').filter((l) => l.startsWith('@@'));
    assert.deepEqual(diff(a, b).hunks.map((h) => h.header), headers);
  });

  test('a Uint8Array from another realm is accepted', () => {
    const foreign = runInNewContext('new Uint8Array([97, 10])') as Uint8Array;
    assert.equal(foreign instanceof Uint8Array, false);
    assert.equal(dec(patch(foreign, enc('b\n'))), '@@ -1 +1 @@\n-a\n+b\n');
    assert.equal(diff(foreign, enc('b\n')).removed, 1);
  });

  test('other views are still refused', () => {
    // @ts-expect-error: deliberately wrong
    assert.throws(() => patch(new Uint16Array(2), 'a'), /Uint16Array/);
    // @ts-expect-error: deliberately wrong
    assert.throws(() => patch(new DataView(new ArrayBuffer(2)), 'a'), /DataView/);
  });

  test('a -U0 diff drops the same common tail as git when it starts with a byte order mark', () => {
    const body = 'x'.repeat(1500);
    const a = `a\nkeep\n﻿${body}\n`;
    const b = `b\nkeep\n﻿${body}\n`;
    writeFileSync(join(dir, 'bom-a'), a);
    writeFileSync(join(dir, 'bom-b'), b);
    const out = git(['-U0', join(dir, 'bom-a'), join(dir, 'bom-b')]).stdout.toString();
    assert.equal(patch(a, b, { context: 0 }), out.slice(out.indexOf('@@')));
  });
});

describe('inline highlighting', () => {
  test('gives up on a huge block at once, without tokenizing all of it', () => {
    const huge = 'word '.repeat(2_000_000);
    const start = performance.now();
    const spans = inline([huge], [huge + 'x']);
    assert.deepEqual(spans, { removed: [[]], added: [[]] });
    assert.ok(performance.now() - start < 1000, `took ${performance.now() - start} ms`);
  });

  test('a line containing a line break does not shift the lines after it', () => {
    const { removed, added } = inline(['x\ny', 'keep this'], ['x\nY', 'keep that']);
    assert.deepEqual(removed, [[[2, 3]], [[5, 9]]]);
    assert.deepEqual(added, [[[2, 3]], [[5, 9]]]);
  });

  test('a CR that ends a line pairs only with another, and shows when it changes', () => {
    assert.deepEqual(inline(['plain\r'], ['plain​hidden\r', 'next one\r']).removed, [[]]);
    assert.deepEqual(inline(['foo\r'], ['foo']), { removed: [[[3, 4]]], added: [[]] });
  });

  test('takes arrays of strings only', () => {
    // @ts-expect-error: deliberately wrong
    assert.throws(() => inline('a', ['b']), TypeError);
    // @ts-expect-error: deliberately wrong
    assert.throws(() => inline(['a'], [1]), TypeError);
  });
});

describe('diffArrays', () => {
  test('takes arrays and typed arrays, and nothing else', () => {
    assert.deepEqual(diffArrays(new Uint8Array([1, 2, 3]), new Uint8Array([1, 3])), [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 1 }]);
    // @ts-expect-error: deliberately wrong
    assert.throws(() => diffArrays('abc', 'abd'), TypeError);
    // @ts-expect-error: deliberately wrong
    assert.throws(() => diffArrays(null, []), TypeError);
    // @ts-expect-error: deliberately wrong
    assert.throws(() => diffArrays([1], [2], { key: 'id' }), TypeError);
  });

  test('NaN matches NaN', () => {
    assert.deepEqual(diffArrays([NaN, 1], [NaN, 2]), [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }]);
  });
});

describe('cli: input', () => {
  test('reads named pipes and links to them, as git does', () => {
    writeFileSync(join(dir, 'p-file'), 'a\n');
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    symlinkSync(join(dir, 'fifo'), join(dir, 'fifo-link'));
    for (const name of ['fifo', 'fifo-link']) {
      const run = (cmd: string) => spawnSync('sh', ['-c', `printf 'b\\n' > fifo & ${cmd} ${name} p-file`], { cwd: dir, env: gitEnv }).stdout.toString();
      assert.equal(run(`"${process.execPath}" "${CLI}"`), run('git diff --no-index --no-color'), name);
    }
  });

  test('standard input against /dev/null has no index line, as in git', () => {
    const ours = hunks(['-', '/dev/null'], { input: 'a\n' });
    const theirs = git(['-', '/dev/null'], { input: 'a\n' });
    assert.equal(ours.stdout.toString(), theirs.stdout.toString());
    assert.doesNotMatch(ours.stdout.toString(), /^index/m);
    assert.equal(ours.status, 1);
  });

  test('refuses devices and sockets instead of reading forever', () => {
    const r = hunks(['/dev/zero', '/dev/null']);
    assert.equal(r.status, 2);
    assert.match(r.stderr.toString(), /'\/dev\/zero' is a character device/);
  });

  test('treats a file over 512 MiB as binary, as git does', () => {
    const big = join(dir, 'big');
    const big2 = join(dir, 'big2');
    // Sparse: no disk space, and git and hunks both stream it.
    execFileSync('truncate', ['-s', '513M', big]);
    execFileSync('truncate', ['-s', '514M', big2]);
    const ours = hunks([big, big2]);
    const theirs = git([big, big2]);
    assert.equal(ours.status, 1);
    assert.equal(ours.stdout.toString(), theirs.stdout.toString());
    assert.match(ours.stdout.toString(), /^Binary files/m);
    assert.equal(hunks([big, big]).status, 0);
  });
});

describe('cli: output', () => {
  const hostileOld = 'safe\nwhat\nok 👨‍👩‍👧 ❤️ 1️⃣\n';
  const hostileNew = 'safe\x1b]52;c;cm0gLXJmIH4=\x07\x1b[2J\nwhat‮ }⁦if (admin)⁩⁦ x\nok 👨‍👩‍👧 ❤️ 1️⃣\nrm -rf ~ # fine\rdocs\nc1 \u009b31m\nhidden' +
    [...'do evil'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('') + '\n';

  test('piped, it is git, byte for byte, even for hostile files', () => {
    writeFileSync(join(dir, 'h-old'), hostileOld);
    writeFileSync(join(dir, 'h-new'), hostileNew);
    assert.deepEqual(hunks(['h-old', 'h-new'], { cwd: dir }).stdout, git(['h-old', 'h-new'], { cwd: dir }).stdout);
  });

  test('on a terminal, nothing in a file reaches the terminal as a control', () => {
    writeFileSync(join(dir, 'h-old'), hostileOld);
    writeFileSync(join(dir, 'h-new'), hostileNew);
    const out = hunks(['--color=always', 'h-old', 'h-new'], { cwd: dir }).stdout.toString();
    // The only escapes are the SGR colour codes hunks writes itself.
    assert.doesNotMatch(out, /\x1b(?!\[[0-9;]*m)/);
    assert.doesNotMatch(out, /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f\u0080-\u009f‪-‮⁦-⁩\u{e0000}-\u{e007f}]/u);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(plain, /\+safe\^\[\]52;c;cm0gLXJmIH4=\^G\^\[\[2J/);
    assert.match(plain, /<U\+202E> }<U\+2066>if \(admin\)<U\+2069>/);
    assert.match(plain, /rm -rf ~ # fine\^Mdocs/);
    assert.match(plain, /c1 <U\+009B>31m/);
    assert.match(plain, /hidden<U\+E0064><U\+E006F>/);
    // Emoji keep their joiners and variation selectors.
    assert.match(plain, / ok 👨‍👩‍👧 ❤️ 1️⃣\n/);
  });

  // script(1) gives the CLI a real pseudo-terminal; its options differ on
  // other systems, so this runs on Linux.
  const pty = process.platform === 'linux' && spawnSync('script', ['--version']).status === 0;

  test('on a real terminal: colour by default, off with NO_COLOR or TERM=dumb, escaping always', { skip: !pty }, () => {
    writeFileSync(join(dir, 't-old'), 'a\n');
    writeFileSync(join(dir, 't-new'), 'b\x1b[2J\n');
    const tty = (env: string) => spawnSync('script', ['-qfec', `env ${env} "${process.execPath}" "${CLI}" t-old t-new`, '/dev/null'], { cwd: dir }).stdout.toString();
    for (const [env, colour] of [['TERM=xterm-256color', true], ['NO_COLOR=1', false], ['TERM=dumb', false]] as const) {
      const out = tty(env);
      assert.equal(out.includes('\x1b[31m'), colour, env);
      assert.ok(!out.includes('\x1b[2J'), `${env}: the file's escape reached the terminal`);
      assert.ok(out.replace(/\x1b\[[0-9;]*m/g, '').includes('+b^[[2J'), env);
    }
  });

  test('error messages are escaped too', () => {
    const r = hunks(['no\x1b]0;title\x07such', '/dev/null']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr.toString(), "hunks: could not access 'no^[]0;title^Gsuch'\n");
  });

  test('stops quietly when the reader goes away', () => {
    const lines = Array.from({ length: 300_000 }, (_, i) => `${i}\n`).join('');
    writeFileSync(join(dir, 'long-a'), lines);
    writeFileSync(join(dir, 'long-b'), lines.replace(/7\n/g, 'x\n'));
    const r = spawnSync('bash', ['-c', `"${process.execPath}" "${CLI}" long-a long-b | head -c 100 > /dev/null; echo "\${PIPESTATUS[0]}"`], { cwd: dir });
    assert.equal(r.stdout.toString().trim(), '141');
    assert.equal(r.stderr.toString(), '');
  });

  test('marks trailing whitespace and spaces before tabs on added lines, as git does', () => {
    writeFileSync(join(dir, 'ws-a'), 'x\n');
    writeFileSync(join(dir, 'ws-b'), '  \tindented\t \n');
    const out = hunks(['--color=always', 'ws-a', 'ws-b'], { cwd: dir }).stdout.toString();
    assert.match(out, /\+\x1b\[41m  \x1b\[49m\tindented\x1b\[41m\t \x1b\[49m/);
  });

  test('marks thousands of trailing spaces in linear time', () => {
    writeFileSync(join(dir, 'sp-a'), 'x\n');
    writeFileSync(join(dir, 'sp-b'), ' '.repeat(200_000) + 'y\n' + 'z' + ' '.repeat(200_000) + '\n');
    const start = performance.now();
    const r = hunks(['--color=always', 'sp-a', 'sp-b'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.ok(performance.now() - start < 5000);
  });
});
