/**
 * Patience diff (Bram Cohen): anchor the comparison on lines that occur
 * exactly once on each side, take the longest increasing run of such
 * anchors, and recurse into the gaps between them. Regions with no unique
 * lines at all are handed to Myers.
 */

import type { Side } from './lines.ts';
import type { Env } from './env.ts';
import { myers } from './myers.ts';

const NON_UNIQUE = -1;

interface Entry {
  line1: number;
  /** 0: absent from the second side; NON_UNIQUE: seen more than once. */
  line2: number;
  previous: Entry | null;
  next: Entry | null;
}

export interface PatienceContext {
  a: Side;
  b: Side;
  ca: Uint8Array;
  cb: Uint8Array;
  needMin: boolean;
  env: Env;
  /** Lines starting with one of these must stay in the common sequence. */
  anchors: readonly string[];
  /** Before git 2.54 the anchor test looked at the first side's line. */
  legacy: boolean;
}

/** Diff 1-based line ranges, as git does. */
export function patience(ctx: PatienceContext, line1: number, count1: number, line2: number, count2: number): void {
  const work: number[] = [line1, count1, line2, count2];
  while (work.length > 0) {
    const c2 = work.pop()!;
    const l2 = work.pop()!;
    const c1 = work.pop()!;
    const l1 = work.pop()!;
    step(ctx, l1, c1, l2, c2, work);
  }
}

function step(ctx: PatienceContext, line1: number, count1: number, line2: number, count2: number, work: number[]): void {
  const { a, b, ca, cb } = ctx;
  ctx.env.check();
  if (count1 === 0) {
    for (let i = 0; i < count2; i++) cb[line2 + i] = 1;
    return;
  }
  if (count2 === 0) {
    for (let i = 0; i < count1; i++) ca[line1 + i] = 1;
    return;
  }

  // Every distinct line of the first range, in order of first appearance.
  const map = new Map<number, Entry>();
  let first: Entry | null = null;
  let last: Entry | null = null;
  for (let l = line1; l < line1 + count1; l++) {
    const id = a.ids[l - 1];
    const e = map.get(id);
    if (e) {
      e.line2 = NON_UNIQUE;
      continue;
    }
    const entry: Entry = { line1: l, line2: 0, previous: last, next: null };
    map.set(id, entry);
    if (last) last.next = entry;
    else first = entry;
    last = entry;
  }

  let hasMatches = false;
  for (let l = line2; l < line2 + count2; l++) {
    const e = map.get(b.ids[l - 1]);
    if (!e) continue;
    hasMatches = true;
    e.line2 = e.line2 !== 0 ? NON_UNIQUE : l;
  }

  if (!hasMatches) {
    for (let i = 0; i < count1; i++) ca[line1 + i] = 1;
    for (let i = 0; i < count2; i++) cb[line2 + i] = 1;
    return;
  }

  const lcs = longestCommonSequence(ctx, first, map.size);
  if (lcs === null) {
    myers(a, b, ca, cb, line1 - 1, count1, line2 - 1, count2, ctx.needMin, ctx.env);
    return;
  }

  // Walk the common sequence, growing each anchor into the matching lines
  // around it, and queue the gaps in between.
  const end1 = line1 + count1;
  const end2 = line2 + count2;
  let cur: Entry | null = lcs;
  for (;;) {
    let next1: number;
    let next2: number;
    if (cur) {
      next1 = cur.line1;
      next2 = cur.line2;
      while (next1 > line1 && next2 > line2 && a.ids[next1 - 2] === b.ids[next2 - 2]) {
        next1--;
        next2--;
      }
    } else {
      next1 = end1;
      next2 = end2;
    }
    while (line1 < next1 && line2 < next2 && a.ids[line1 - 1] === b.ids[line2 - 1]) {
      line1++;
      line2++;
    }
    if (next1 > line1 || next2 > line2) work.push(line1, next1 - line1, line2, next2 - line2);
    if (!cur) return;
    while (cur.next && cur.next.line1 === cur.line1 + 1 && cur.next.line2 === cur.line2 + 1) cur = cur.next;
    line1 = cur.line1 + 1;
    line2 = cur.line2 + 1;
    cur = cur.next;
  }
}

function isAnchor(ctx: PatienceContext, e: Entry): boolean {
  if (ctx.anchors.length === 0) return false;
  const side = ctx.legacy ? ctx.a : ctx.b;
  const start = side.starts[(ctx.legacy ? e.line1 : e.line2) - 1];
  for (const anchor of ctx.anchors) {
    if (side.text.startsWith(anchor, start)) return true;
  }
  return false;
}

/**
 * Longest sequence of unique-on-both-sides lines that is increasing in both
 * files, by patience sorting. Returns the head of the chain, relinked
 * through `next`, or null when there is no such line.
 */
function longestCommonSequence(ctx: PatienceContext, first: Entry | null, size: number): Entry | null {
  const sequence: Entry[] = new Array(size);
  let longest = 0;
  let anchorAt = -1;

  for (let e = first; e; e = e.next) {
    if (e.line2 === 0 || e.line2 === NON_UNIQUE) continue;
    let i: number;
    if (longest === 0 || e.line2 > sequence[longest - 1].line2) {
      i = longest - 1;
    } else {
      // Largest index whose entry has a smaller line2.
      let left = -1;
      let right = longest;
      while (left + 1 < right) {
        const middle = left + ((right - left) >> 1);
        if (sequence[middle].line2 > e.line2) right = middle;
        else left = middle;
      }
      i = left;
    }
    e.previous = i < 0 ? null : sequence[i];
    i++;
    if (i <= anchorAt) continue;
    sequence[i] = e;
    if (isAnchor(ctx, e)) {
      anchorAt = i;
      longest = anchorAt + 1;
    } else if (i === longest) {
      longest++;
    }
  }

  if (longest === 0) return null;

  let e = sequence[longest - 1];
  e.next = null;
  while (e.previous) {
    e.previous.next = e;
    e = e.previous;
  }
  return e;
}
