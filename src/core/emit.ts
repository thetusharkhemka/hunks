/**
 * From an edit script to hunks: which changes share a hunk, how much context
 * surrounds them, and what goes into the "@@ ... @@" header. Follows the
 * rules of git's emitter, including its handling of ignorable changes
 * (--ignore-blank-lines, --ignore-matching-lines) and of --function-context.
 */

import { isEmptyRecord, type Side } from './lines.ts';

export interface Change {
  /** First changed record on each side (0-based). */
  i1: number;
  i2: number;
  /** Number of changed records on each side. */
  chg1: number;
  chg2: number;
  /** Set when the change only touches ignorable lines. */
  ignore: boolean;
}

/** Recognises a function line; returns the raw heading text or null. */
export type FuncMatcher = (side: Side, i: number) => string | null;

export interface EmitOptions {
  context: number;
  interHunkContext: number;
  functionContext: boolean;
  /** Present when hunk headers should carry a function name. */
  funcname: FuncMatcher | null;
}

export interface RawHunk {
  /** Record ranges [s, e) on each side. */
  s1: number;
  e1: number;
  s2: number;
  e2: number;
  /** Indices into the change list, inclusive. */
  first: number;
  last: number;
  /** Raw heading text, or null. */
  heading: string | null;
}

/** git's default rule for a function line: it starts with a letter, _ or $. */
export const defaultFuncname: FuncMatcher = (side, i) => {
  const s = side.starts[i];
  if (s === side.starts[i + 1]) return null;
  const c = side.text.charCodeAt(s);
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
    return side.text.slice(s, side.starts[i + 1]);
  }
  return null;
};

/**
 * Pick the last change that belongs in the hunk starting at `start`, after
 * first skipping leading ignorable changes that are too far from anything.
 * Returns [first, last] or null when nothing is left.
 */
function nextHunk(changes: Change[], start: number, opts: EmitOptions): [number, number] | null {
  const maxCommon = 2 * opts.context + opts.interHunkContext;
  const maxIgnorable = opts.context;

  let first = start;
  for (let p = start; p < changes.length && changes[p].ignore; p++) {
    const next = p + 1 < changes.length ? changes[p + 1] : null;
    if (next === null || next.i1 - (changes[p].i1 + changes[p].chg1) >= maxIgnorable) first = p + 1;
  }
  if (first >= changes.length) return null;

  let last = first;
  let ignored = 0;
  for (let p = first, q = first + 1; q < changes.length; p = q, q++) {
    const prev = changes[p];
    const cur = changes[q];
    const distance = cur.i1 - (prev.i1 + prev.chg1);
    if (distance > maxCommon) break;
    if (distance < maxIgnorable && (!cur.ignore || last === p)) {
      last = q;
      ignored = 0;
    } else if (distance < maxIgnorable && cur.ignore) {
      ignored += cur.chg2;
    } else if (last !== p && cur.i1 + ignored - (changes[last].i1 + changes[last].chg1) > maxCommon) {
      break;
    } else if (!cur.ignore) {
      last = q;
      ignored = 0;
    } else {
      ignored += cur.chg2;
    }
  }
  return [first, last];
}

/** Search for a function line from `start` toward `limit` (exclusive). */
function findFunc(a: Side, match: FuncMatcher, start: number, limit: number): number {
  const step = start > limit ? -1 : 1;
  for (let l = start; l !== limit && l >= 0 && l < a.n; l += step) {
    if (match(a, l) !== null) return l;
  }
  return -1;
}

export function emit(a: Side, b: Side, changes: Change[], opts: EmitOptions): RawHunk[] {
  const hunks: RawHunk[] = [];
  const ctx = opts.context;
  const match = opts.funcname ?? defaultFuncname;
  let headingPrev = -1;
  let heading: string | null = null;

  let next = 0;
  while (next < changes.length) {
    // Where this hunk would have started before ignorable changes were skipped.
    let skipped = next;
    const range = nextHunk(changes, next, opts);
    if (range === null) break;
    let [first, last] = range;

    let s1 = 0;
    let s2 = 0;
    for (;;) {
      s1 = Math.max(changes[first].i1 - ctx, 0);
      s2 = Math.max(changes[first].i2 - ctx, 0);
      if (!opts.functionContext) break;

      let i1 = changes[first].i1;
      if (i1 >= a.n) {
        // Appended at the end: no extra context if a whole function was added.
        let wholeFunction = false;
        for (let i2 = changes[first].i2; i2 < b.n; i2++) {
          if (match(b, i2) !== null) {
            wholeFunction = true;
            break;
          }
        }
        if (wholeFunction) break;
        i1 = a.n - 1;
      }
      let fs1 = findFunc(a, match, i1, -1);
      while (fs1 > 0 && !isEmptyRecord(a, fs1 - 1) && match(a, fs1 - 1) === null) fs1--;
      if (fs1 < 0) fs1 = 0;
      if (fs1 < s1) {
        s2 = Math.max(s2 - (s1 - fs1), 0);
        s1 = fs1;
        // Extended upward into a skipped ignorable change? Then show it.
        while (skipped !== first &&
               changes[skipped].i1 + changes[skipped].chg1 <= s1 &&
               changes[skipped].i2 + changes[skipped].chg2 <= s2) skipped++;
        if (skipped !== first) {
          first = skipped;
          continue;
        }
      }
      break;
    }

    let e1 = 0;
    let e2 = 0;
    for (;;) {
      const end = changes[last];
      const lctx = Math.min(ctx, a.n - (end.i1 + end.chg1), b.n - (end.i2 + end.chg2));
      e1 = end.i1 + end.chg1 + lctx;
      e2 = end.i2 + end.chg2 + lctx;
      if (!opts.functionContext) break;

      let fe1 = findFunc(a, match, end.i1 + end.chg1, a.n);
      while (fe1 > 0 && isEmptyRecord(a, fe1 - 1)) fe1--;
      if (fe1 < 0) fe1 = a.n;
      if (fe1 > e1) {
        e2 = Math.min(e2 + (fe1 - e1), b.n);
        e1 = fe1;
      }
      // Overlaps the next change? Take it in and recompute the end.
      if (last + 1 < changes.length) {
        const l = Math.min(changes[last + 1].i1, a.n - 1);
        if (l - ctx <= e1 || findFunc(a, match, l, e1) < 0) {
          last++;
          continue;
        }
      }
      break;
    }

    if (opts.funcname !== null) {
      // The nearest function line above the hunk. The search stops where the
      // previous hunk's began; if it finds nothing, that hunk's heading holds.
      const start = s1 - 1;
      const step = start > headingPrev ? -1 : 1;
      for (let l = start; l !== headingPrev && l >= 0 && l < a.n; l += step) {
        const h = opts.funcname(a, l);
        if (h !== null) {
          heading = h;
          break;
        }
      }
      headingPrev = s1 - 1;
    }

    hunks.push({ s1, e1, s2, e2, first, last, heading: opts.funcname !== null ? heading : null });
    next = last + 1;
  }
  return hunks;
}
