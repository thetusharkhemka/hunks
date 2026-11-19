import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { diff, diffArrays, edits, inline, patch } from '../src/index.ts';

// Expected outputs in this file were produced by `git diff --no-index`.
const before = `function parse(input) {
  const tokens = lex(input);
  return build(tokens);
}

function check(tokens) {
  for (const t of tokens) {
    validate(t);
  }
}

function render(node) {
  return node.children.map(render).join('');
}
`;

const after = `function parse(input) {
  const tokens = lex(input);
  if (!tokens.length) return null;
  return build(tokens);
}

function check(tokens) {
  for (const t of tokens) {
    validate(t);
  }
}

function render(node) {
  return node.children.map(render).join('\\n');
}
`;

describe('patch', () => {
  test('prints hunks with function headings, like git', () => {
    assert.equal(
      patch(before, after),
      [
        '@@ -1,5 +1,6 @@',
        ' function parse(input) {',
        '   const tokens = lex(input);',
        '+  if (!tokens.length) return null;',
        '   return build(tokens);',
        ' }',
        ' ',
        '@@ -10,5 +11,5 @@ function check(tokens) {',
        ' }',
        ' ',
        ' function render(node) {',
        "-  return node.children.map(render).join('');",
        "+  return node.children.map(render).join('\\n');",
        ' }',
        '',
      ].join('\n'),
    );
  });

  test('adds file headers when names are given', () => {
    const out = patch('a\n', 'b\n', { fromFile: 'a/x.txt', toFile: 'b/x.txt' });
    assert.equal(out, '--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n');
  });

  test('is empty for equal input, headers included', () => {
    assert.equal(patch('same\n', 'same\n', { fromFile: 'a', toFile: 'b' }), '');
    assert.equal(patch('', ''), '');
  });

  test('marks a missing final newline', () => {
    assert.equal(patch('a\nb', 'a\nb\n'), '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');
  });

  test('handles empty sides', () => {
    assert.equal(patch('', 'x\ny\n'), '@@ -0,0 +1,2 @@\n+x\n+y\n');
    assert.equal(patch('x\n', ''), '@@ -1 +0,0 @@\n-x\n');
  });

  test('keeps CRLF line endings intact', () => {
    assert.equal(patch('a\r\nb\r\n', 'a\r\nc\r\n'), '@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n');
  });

  test('returns bytes for bytes, including invalid UTF-8', () => {
    const a = new Uint8Array([0x61, 0x0a, 0xff, 0x0a]);
    const b = new Uint8Array([0x61, 0x0a, 0xfe, 0x0a]);
    const out = patch(a, b);
    assert.ok(out instanceof Uint8Array);
    assert.deepEqual([...out], [...new TextEncoder().encode('@@ -1,2 +1,2 @@\n a\n-'), 0xff, 0x0a, 0x2b, 0xfe, 0x0a]);
  });

  test('text and bytes agree on valid UTF-8', () => {
    const a = 'naïve café\nκόσμε\n\u{1f600}\n';
    const b = 'naive café\nκόσμε!\n\u{1f600}\n';
    const enc = new TextEncoder();
    assert.equal(new TextDecoder().decode(patch(enc.encode(a), enc.encode(b))), patch(a, b));
  });

  test('context option', () => {
    const a = 'a\nb\nc\nd\ne\nf\ng\n';
    const b = 'a\nb\nc\nD\ne\nf\ng\n';
    assert.equal(patch(a, b, { context: 0 }), '@@ -4 +4 @@ c\n-d\n+D\n');
    assert.equal(patch(a, b, { context: 1 }), '@@ -3,3 +3,3 @@ b\n c\n-d\n+D\n e\n');
  });

  test('funcname: false, a pattern, or a function', () => {
    const a = 'def f():\n    x = 1\n    y = 2\n    z = 3\n    w = 4\n';
    const b = 'def f():\n    x = 1\n    y = 2\n    z = 3\n    w = 5\n';
    assert.match(patch(a, b), /^@@ -2,4 \+2,4 @@ def f\(\):\n/);
    assert.match(patch(a, b, { funcname: false }), /^@@ -2,4 \+2,4 @@\n/);
    assert.match(patch(a, b, { funcname: /^def (\w+)/ }), /^@@ -2,4 \+2,4 @@ f\n/);
    assert.match(patch(a, b, { funcname: (l) => (l.startsWith('def') ? 'fn' : null) }), /^@@ -2,4 \+2,4 @@ fn\n/);
  });

  test('ignores whitespace on request', () => {
    assert.equal(patch('a  b\n', 'a b\n', { ignoreWhitespaceChange: true }), '');
    assert.equal(patch('ab\n', 'a b\n', { ignoreWhitespace: true }), '');
    assert.equal(patch('a\r\n', 'a\n', { ignoreCrAtEol: true }), '');
    assert.equal(patch('a \n', 'a\n', { ignoreWhitespaceAtEol: true }), '');
    assert.equal(patch('a\n\nb\n', 'a\nb\n', { ignoreBlankLines: true }), '');
  });

  test('validates options', () => {
    assert.throws(() => patch('a', 'b', { context: -1 }), RangeError);
    assert.throws(() => patch('a', 'b', { context: 1.5 }), RangeError);
    // @ts-expect-error: not an algorithm
    assert.throws(() => patch('a', 'b', { algorithm: 'quick' }), TypeError);
  });
});

describe('diff', () => {
  test('describes every line', () => {
    const d = diff('a\nb\nc\n', 'a\nB\nc\nd');
    assert.equal(d.added, 2);
    assert.equal(d.removed, 1);
    assert.equal(d.hunks.length, 1);
    const h = d.hunks[0];
    assert.deepEqual([h.oldStart, h.oldLines, h.newStart, h.newLines], [1, 3, 1, 4]);
    assert.equal(h.header, '@@ -1,3 +1,4 @@');
    assert.equal(h.heading, '');
    assert.deepEqual(
      h.lines.map((l) => [l.type, l.text, l.oldNumber, l.newNumber, l.newline]),
      [
        ['context', 'a', 1, 1, true],
        ['removed', 'b', 2, null, true],
        ['added', 'B', null, 2, true],
        ['context', 'c', 3, 3, true],
        ['added', 'd', null, 4, false],
      ],
    );
  });

  test('carries the heading separately', () => {
    const h = diff(before, after).hunks[1];
    assert.equal(h.heading, 'function check(tokens) {');
    assert.equal(h.header, '@@ -10,5 +11,5 @@ function check(tokens) {');
  });

  test('numbers empty ranges the way the header does', () => {
    const h = diff('', 'x\n').hunks[0];
    assert.deepEqual([h.oldStart, h.oldLines, h.newStart, h.newLines], [0, 0, 1, 1]);
  });

  test('inline spans mark the changed words', () => {
    const d = diff('const total = price * quantity;\n', 'const total = price * amount;\n', { inline: true });
    const [removed, added] = d.hunks[0].lines;
    assert.deepEqual(removed.spans, [[22, 30]]);
    assert.deepEqual(added.spans, [[22, 28]]);
    assert.equal(removed.text.slice(22, 30), 'quantity');
    assert.equal(added.text.slice(22, 28), 'amount');
  });

  test('a line with no counterpart gets no spans', () => {
    const d = diff('a\n', 'a\nbrand new line\n', { inline: true });
    const added = d.hunks[0].lines.find((l) => l.type === 'added')!;
    assert.deepEqual(added.spans, []);
  });
});

describe('edits', () => {
  test('returns slice-ready ranges', () => {
    const a = 'a\nb\nc\nd\n';
    const b = 'a\nx\nc\nd\ne\n';
    assert.deepEqual(edits(a, b), [
      { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 },
      { oldStart: 4, oldEnd: 4, newStart: 4, newEnd: 5 },
    ]);
  });
});

describe('diffArrays', () => {
  test('works on any sequence', () => {
    assert.deepEqual(diffArrays([1, 2, 3, 4], [1, 3, 4, 5]), [
      { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 1 },
      { oldStart: 4, oldEnd: 4, newStart: 3, newEnd: 4 },
    ]);
  });

  test('compares by key', () => {
    const a = [{ id: 1 }, { id: 2 }];
    const b = [{ id: 1 }, { id: 3 }];
    assert.deepEqual(diffArrays(a, b, { key: (x) => x.id }), [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }]);
  });

  test('every algorithm yields a valid edit script', () => {
    const a = 'the quick brown fox jumps over the lazy dog'.split(' ');
    const b = 'the quick red fox leaps over the very lazy dog'.split(' ');
    for (const algorithm of ['myers', 'minimal', 'patience', 'histogram'] as const) {
      const result: string[] = [];
      let i = 0;
      for (const e of diffArrays(a, b, { algorithm })) {
        result.push(...a.slice(i, e.oldStart), ...b.slice(e.newStart, e.newEnd));
        i = e.oldEnd;
      }
      result.push(...a.slice(i));
      assert.deepEqual(result, b, algorithm);
    }
  });
});

describe('inline', () => {
  test('pairs lines through the alignment, not by position', () => {
    const { removed, added } = inline(['alpha();', 'beta(1);'], ['beta(2);']);
    assert.deepEqual(removed[0], []);
    assert.deepEqual(added[0], [[5, 6]]);
    assert.deepEqual(removed[1], [[5, 6]]);
  });
});

describe('edge cases', () => {
  test('labels are quoted as git quotes paths, in text and byte mode', () => {
    const out = patch(new TextEncoder().encode('a\n'), new TextEncoder().encode('b\n'), { fromFile: 'a/café.txt', toFile: 'b/café.txt' });
    assert.equal(new TextDecoder().decode(out), '--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n');
    assert.equal(patch('a\n', 'b\n', { fromFile: 'a/café.txt' }).split('\n')[0], '--- "a/caf\\303\\251.txt"');
  });

  test('a funcname pattern sees lines without their CRLF', () => {
    const a = 'sub run\r\n  x\r\n  y\r\n  z\r\n  w\r\n';
    const b = 'sub run\r\n  x\r\n  y\r\n  z\r\n  W\r\n';
    assert.match(patch(a, b, { funcname: /^sub (\w+)$/ }), /^@@ -2,4 \+2,4 @@ run\n/);
  });
});

describe('input handling', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);

  test('non-ASCII options work the same in byte mode as in text mode', () => {
    const a = 'café()\n  un\n  deux\n  trois\n  quatre\n';
    const b = 'café()\n  un\n  deux\n  trois\n  QUATRE\n';
    const options = { funcname: /^(café)/ };
    assert.equal(dec(patch(enc(a), enc(b), options)), patch(a, b, options));
    assert.match(patch(a, b, options), /@@ café\n/);

    const fn = { funcname: (line: string) => (line.startsWith('café') ? 'là' : null) };
    assert.equal(dec(patch(enc(a), enc(b), fn)), patch(a, b, fn));

    const ignore = { ignoreMatchingLines: /QUATRE|quatre/ };
    assert.equal(patch(a, b, ignore), '');
    assert.equal(patch(enc(a), enc(b), ignore).length, 0);

    const x = 'é1\nb\né2\n';
    const y = 'é2\nb\né1\n';
    assert.equal(dec(patch(enc(x), enc(y), { anchored: 'é2' })), patch(x, y, { anchored: 'é2' }));
  });

  test('a string and bytes can be mixed', () => {
    const out = patch('naïve\n', enc('naive\n'));
    assert.ok(out instanceof Uint8Array);
    assert.equal(dec(out), '@@ -1 +1 @@\n-naïve\n+naive\n');
    assert.deepEqual(edits('naïve\n', enc('naïve\n')), []);
  });

  test('diff() reads bytes as UTF-8 text', () => {
    const d = diff(enc('café\n'), enc('café!\n'));
    assert.deepEqual(d.hunks[0].lines.map((l) => l.text), ['café', 'café!']);
  });

  test('rejects what is not text', () => {
    // @ts-expect-error: deliberately wrong
    assert.throws(() => patch(undefined, 'a'), TypeError);
    // @ts-expect-error: deliberately wrong
    assert.throws(() => diff('a', 42), TypeError);
    // @ts-expect-error: deliberately wrong
    assert.throws(() => edits(null, 'a'), TypeError);
    // @ts-expect-error: deliberately wrong
    assert.throws(() => patch('a\n', 'b\n', { funcname: 'x' }), TypeError);
    // @ts-expect-error: deliberately wrong
    assert.throws(() => patch('f\n1\n2\n3\n4\na\n', 'f\n1\n2\n3\n4\nb\n', { funcname: () => 1 }), TypeError);
  });
});
