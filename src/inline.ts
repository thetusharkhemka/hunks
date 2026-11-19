/**
 * Word-level highlighting inside changed lines.
 *
 * Instead of guessing which removed line corresponds to which added line,
 * the whole block of removed lines is compared with the whole block of added
 * lines as two token sequences, with the same engine as everything else.
 * Pairing falls out of the alignment, including when lines are split,
 * joined or reordered.
 */

import { compact } from './core/compact.ts';
import type { Side } from './core/lines.ts';
import { myers, MyersEnv } from './core/myers.ts';

/** A changed range within a line: [start, end) in UTF-16 offsets. */
export type Span = [start: number, end: number];

// Words (letters, marks, digits, underscore), runs of spaces, line breaks,
// and everything else one code point at a time.
const TOKEN = /[\p{L}\p{M}\p{N}_]+|[^\S\n]+|\n|[\s\S]/gu;

/**
 * Above this share of changed characters a line is treated as rewritten:
 * highlighting most of a line tells the reader nothing.
 */
const REWRITE_THRESHOLD = 0.6;

function tokenize(lines: readonly string[]): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) tokens.push('\n');
    for (const m of lines[i].matchAll(TOKEN)) tokens.push(m[0]);
  }
  return tokens;
}

function sequenceSide(ids: Int32Array): Side {
  return { text: '', starts: new Int32Array(ids.length + 1), n: ids.length, ids };
}

/**
 * Compute the changed spans of each removed and each added line.
 * A line with no spans is either entirely new or has no comparable
 * counterpart; render it without emphasis.
 */
export function inlineSpans(removed: readonly string[], added: readonly string[]): { removed: Span[][]; added: Span[][] } {
  const ta = tokenize(removed);
  const tb = tokenize(added);

  const table = new Map<string, number>();
  const intern = (t: string): number => {
    let id = table.get(t);
    if (id === undefined) table.set(t, (id = table.size));
    return id;
  };
  const a = sequenceSide(Int32Array.from(ta, intern));
  const b = sequenceSide(Int32Array.from(tb, intern));
  const ca = new Uint8Array(a.n + 2);
  const cb = new Uint8Array(b.n + 2);
  const env = new MyersEnv(table.size);
  myers(a, b, ca, cb, 0, a.n, 0, b.n, false, env);
  const opts = { indentHeuristic: false, rediff: false, needMin: false, env };
  compact(a, ca, b, cb, opts);
  compact(b, cb, a, ca, opts);

  cleanup(ta, ca, tb, cb);

  return {
    removed: toSpans(removed, ta, ca),
    added: toSpans(added, tb, cb),
  };
}

/**
 * Absorb short equalities into the edits around them, so that "foo(a, b)"
 * against "bar(c, d)" highlights one span instead of four. An equality goes
 * when it is no longer than the changed text on either side of it.
 */
function cleanup(ta: string[], ca: Uint8Array, tb: string[], cb: Uint8Array): void {
  for (let pass = 0; pass < 8; pass++) {
    let changedAny = false;
    // Walk aligned runs: (changed a, changed b), then an equal run.
    let i = 0;
    let j = 0;
    let prevChanged = 0;
    while (i < ta.length || j < tb.length) {
      let changedLen = 0;
      while (i < ta.length && ca[i + 1]) changedLen += ta[i++].length;
      while (j < tb.length && cb[j + 1]) changedLen += tb[j++].length;
      const eqStartA = i;
      const eqStartB = j;
      let eqLen = 0;
      let hasBreak = false;
      while (i < ta.length && j < tb.length && !ca[i + 1] && !cb[j + 1]) {
        if (ta[i] === '\n') hasBreak = true;
        eqLen += ta[i].length;
        i++;
        j++;
      }
      if (i === eqStartA) break;
      // Peek at the changes that follow this equality.
      let nextChanged = 0;
      for (let k = i; k < ta.length && ca[k + 1]; k++) nextChanged += ta[k].length;
      for (let k = j; k < tb.length && cb[k + 1]; k++) nextChanged += tb[k].length;
      const before = changedLen > 0 ? changedLen : prevChanged;
      if (!hasBreak && before > 0 && nextChanged > 0 && eqLen <= Math.min(before, nextChanged)) {
        for (let k = eqStartA; k < i; k++) ca[k + 1] = 1;
        for (let k = eqStartB; k < j; k++) cb[k + 1] = 1;
        changedAny = true;
      }
      prevChanged = changedLen;
    }
    if (!changedAny) break;
  }
}

function toSpans(lines: readonly string[], tokens: string[], changed: Uint8Array): Span[][] {
  const result: Span[][] = [];
  let t = 0;
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) t++; // the line break token
    const spans: Span[] = [];
    let pos = 0;
    let changedChars = 0;
    let total = 0;
    for (; t < tokens.length && tokens[t] !== '\n'; t++) {
      const tok = tokens[t];
      const end = pos + tok.length;
      const blank = tok.trim() === '';
      if (!blank) total += tok.length;
      if (changed[t + 1]) {
        if (!blank) changedChars += tok.length;
        const last = spans[spans.length - 1];
        if (last && last[1] === pos) last[1] = end;
        else spans.push([pos, end]);
      }
      pos = end;
    }
    const rewritten = total === 0 ? spans.length > 0 && spans[0][1] - spans[0][0] === pos : changedChars / total > REWRITE_THRESHOLD;
    result.push(rewritten ? [] : spans);
  }
  return result;
}
