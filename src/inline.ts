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
import { Env, NO_DEADLINE, type Deadline } from './core/env.ts';
import { myers } from './core/myers.ts';

/** A changed range within a line: [start, end) in UTF-16 offsets. */
export type Span = [start: number, end: number];

// Words (letters, marks, digits, underscore), runs of other whitespace,
// and everything else one code point at a time. Every alternative matches
// at least one character, so the scan always advances.
const TOKEN = /[\p{L}\p{M}\p{N}_]+|\s+|[\s\S]/gu;

/**
 * Above this share of changed characters a line is treated as rewritten:
 * highlighting most of a line tells the reader nothing.
 */
const REWRITE_THRESHOLD = 0.6;

/**
 * Blocks larger than this (in tokens, both sides together) are left without
 * highlights: nobody reads word-level emphasis across thousands of lines,
 * and it bounds the cost on huge rewrites. Counting stops as soon as the
 * budget runs out, so a huge line costs no more than a small one.
 */
const MAX_TOKENS = 50_000;

/**
 * The class of the break between two lines. Tokens get ids from 2 up, so no
 * text can produce it, not even a line that itself contains "\n".
 */
const BREAK = 0;

/**
 * A carriage return that ends a line, as in files with Windows line endings.
 * It is part of the line ending, not a space between words: it matches only
 * another line-ending CR, and changes on either side of it stay apart.
 */
const CR_END = 1;

interface Tokens {
  /** Class ids, with BREAK between lines. */
  ids: number[];
  /** The text of each token, '' for a BREAK. */
  text: string[];
}

function tokenize(lines: readonly string[], intern: (token: string) => number, budget: { left: number }): Tokens | null {
  const ids: number[] = [];
  const text: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      if (--budget.left < 0) return null;
      ids.push(BREAK);
      text.push('');
    }
    const cr = lines[i].endsWith('\r');
    const line = cr ? lines[i].slice(0, -1) : lines[i];
    TOKEN.lastIndex = 0;
    for (let m = TOKEN.exec(line); m !== null; m = TOKEN.exec(line)) {
      if (--budget.left < 0) return null;
      ids.push(intern(m[0]));
      text.push(m[0]);
    }
    if (cr) {
      if (--budget.left < 0) return null;
      ids.push(CR_END);
      text.push('\r');
    }
  }
  return { ids, text };
}

function sequenceSide(ids: number[]): Side {
  return { text: '', starts: new Int32Array(ids.length + 1), n: ids.length, ids: Int32Array.from(ids) };
}

/**
 * Compute the changed spans of each removed and each added line.
 * A line with no spans is either entirely new or has no comparable
 * counterpart; render it without emphasis.
 */
export function inlineSpans(
  removed: readonly string[],
  added: readonly string[],
  deadline: Deadline = NO_DEADLINE,
): { removed: Span[][]; added: Span[][] } {
  const table = new Map<string, number>();
  const intern = (t: string): number => {
    let id = table.get(t);
    if (id === undefined) table.set(t, (id = table.size + 2));
    return id;
  };
  const budget = { left: MAX_TOKENS };
  const ta = tokenize(removed, intern, budget);
  const tb = ta && tokenize(added, intern, budget);
  if (ta === null || tb === null) {
    return { removed: removed.map(() => []), added: added.map(() => []) };
  }

  const a = sequenceSide(ta.ids);
  const b = sequenceSide(tb.ids);
  const ca = new Uint8Array(a.n + 2);
  const cb = new Uint8Array(b.n + 2);
  const env = new Env(table.size + 2, { deadline });
  myers(a, b, ca, cb, 0, a.n, 0, b.n, false, env);
  const opts = { indentHeuristic: false, rediff: false, needMin: false, env };
  compact(a, ca, b, cb, opts);
  compact(b, cb, a, ca, opts);

  cleanup(ta, ca, tb, cb);

  return {
    removed: toSpans(removed.length, ta, ca),
    added: toSpans(added.length, tb, cb),
  };
}

const isBlank = (token: string): boolean => token.trim() === '';

/**
 * Join changed words separated only by spaces into one span, so that a
 * rewritten phrase reads as one change rather than a row of fragments.
 * Punctuation is left alone: in code, a quote or a bracket that survives an
 * edit is exactly what tells you where the edit happened.
 */
function cleanup(ta: Tokens, ca: Uint8Array, tb: Tokens, cb: Uint8Array): void {
  const na = ta.ids.length;
  const nb = tb.ids.length;
  let i = 0;
  let j = 0;
  let changedBefore = false;
  while (i < na || j < nb) {
    if (ca[i + 1] || cb[j + 1]) {
      while (i < na && ca[i + 1]) i++;
      while (j < nb && cb[j + 1]) j++;
      changedBefore = true;
      continue;
    }
    const startA = i;
    const startB = j;
    let blank = true;
    while (i < na && j < nb && !ca[i + 1] && !cb[j + 1]) {
      if (ta.ids[i] === BREAK || ta.ids[i] === CR_END || !isBlank(ta.text[i])) blank = false;
      i++;
      j++;
    }
    // Unchanged tokens pair up one to one, so this always advances; guard anyway.
    if (i === startA && j === startB) break;
    const changedAfter = (i < na && ca[i + 1] === 1) || (j < nb && cb[j + 1] === 1);
    if (blank && changedBefore && changedAfter) {
      for (let k = startA; k < i; k++) ca[k + 1] = 1;
      for (let k = startB; k < j; k++) cb[k + 1] = 1;
    }
    changedBefore = false;
  }
}

function toSpans(lineCount: number, tokens: Tokens, changed: Uint8Array): Span[][] {
  const { ids, text } = tokens;
  const result: Span[][] = [];
  let t = 0;
  for (let li = 0; li < lineCount; li++) {
    if (li > 0) t++; // the BREAK
    const spans: Span[] = [];
    let pos = 0;
    let changedChars = 0;
    let total = 0;
    for (; t < ids.length && ids[t] !== BREAK; t++) {
      const tok = text[t];
      const end = pos + tok.length;
      const blank = isBlank(tok);
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
