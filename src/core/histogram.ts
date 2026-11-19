/**
 * Histogram diff.
 *
 * An extension of patience diff that, instead of requiring anchors to be
 * unique, prefers the matching region whose lines are rarest in the first
 * input, and falls back to Myers when every candidate is too common.
 *
 * The algorithm was introduced by JGit (HistogramDiff.java, Copyright (C)
 * 2010 Google Inc., Eclipse Distribution License 1.0) and ported to git's
 * xdiff as xhistogram.c under the same license. This is an independent
 * TypeScript implementation that follows that design closely; see NOTICE.
 *
 * On crafted input the recursion can go as deep as the input is long, so
 * the total cost is quadratic, as in git. Each step therefore works in flat
 * arrays allocated once per diff, and checks the time limit.
 */

import type { Env } from './env.ts';
import type { Side } from './lines.ts';
import { myers } from './myers.ts';

/** More occurrences than this and a line is too common to anchor on. */
const MAX_CHAIN_LENGTH = 64;

export interface HistogramContext {
  a: Side;
  b: Side;
  ca: Uint8Array;
  cb: Uint8Array;
  needMin: boolean;
  env: Env;
}

/** Diff 1-based line ranges, as git does. */
export function histogram(ctx: HistogramContext, line1: number, count1: number, line2: number, count2: number): void {
  ctx.env.histogramIndex(ctx.a.n);
  const work: number[] = [line1, count1, line2, count2];
  while (work.length > 0) {
    let c2 = work.pop()!;
    let l2 = work.pop()!;
    let c1 = work.pop()!;
    let l1 = work.pop()!;
    // The right-hand part is iterated here; the left-hand part is queued.
    for (;;) {
      if (c1 <= 0 && c2 <= 0) break;
      if (c1 === 0) {
        for (let i = 0; i < c2; i++) ctx.cb[l2 + i] = 1;
        break;
      }
      if (c2 === 0) {
        for (let i = 0; i < c1; i++) ctx.ca[l1 + i] = 1;
        break;
      }
      ctx.env.check();
      const found = findLcs(ctx, l1, c1, l2, c2);
      if (found === FALL_BACK) {
        myers(ctx.a, ctx.b, ctx.ca, ctx.cb, l1 - 1, c1, l2 - 1, c2, ctx.needMin, ctx.env);
        break;
      }
      if (found === NOTHING_IN_COMMON) {
        for (let i = 0; i < c1; i++) ctx.ca[l1 + i] = 1;
        for (let i = 0; i < c2; i++) ctx.cb[l2 + i] = 1;
        break;
      }
      work.push(l1, lcs.begin1 - l1, l2, lcs.begin2 - l2);
      const end1 = l1 + c1 - 1;
      const end2 = l2 + c2 - 1;
      c1 = end1 - lcs.end1;
      l1 = lcs.end1 + 1;
      c2 = end2 - lcs.end2;
      l2 = lcs.end2 + 1;
    }
  }
}

const FOUND = 0;
const FALL_BACK = 1;
const NOTHING_IN_COMMON = 2;

/** The region found by the last findLcs call; module scope avoids allocating. */
const lcs = { begin1: 0, end1: 0, begin2: 0, end2: 0 };

/**
 * Find the longest common region whose rarest line is as rare as possible,
 * leaving it in `lcs`. Reports when the inputs share lines that are all too
 * common (fall back to Myers) or share none at all.
 */
function findLcs(ctx: HistogramContext, line1: number, count1: number, line2: number, count2: number): number {
  const ids1 = ctx.a.ids;
  const ids2 = ctx.b.ids;
  const env = ctx.env;
  const ptrOf = env.histPtr!;
  const cntOf = env.histCnt!;
  const stamp = env.histStamp!;
  const next = env.histNext!;
  const end1 = line1 + count1 - 1;
  const end2 = line2 + count2 - 1;

  if (env.generation === 0x7fffffff) {
    stamp.fill(0);
    env.generation = 0;
  }
  const gen = ++env.generation;

  // Index the first range by class. Scanning backwards leaves each class's
  // chain of occurrences (next[]) in ascending order.
  for (let ptr = end1; ptr >= line1; ptr--) {
    const id = ids1[ptr - 1];
    if (stamp[id] === gen) {
      next[ptr] = ptrOf[id];
      ptrOf[id] = ptr;
      cntOf[id]++;
    } else {
      stamp[id] = gen;
      ptrOf[id] = ptr;
      cntOf[id] = 1;
      next[ptr] = 0;
    }
  }

  lcs.begin1 = lcs.end1 = lcs.begin2 = lcs.end2 = 0;
  let bestCnt = MAX_CHAIN_LENGTH + 1;
  let hasCommon = false;

  for (let bPtr = line2, steps = 0; bPtr <= end2; steps++) {
    if ((steps & 4095) === 4095) env.check();
    let bNext = bPtr + 1;
    const id = ids2[bPtr - 1];
    if (stamp[id] === gen) {
      hasCommon = true;
      const cnt = cntOf[id];
      if (cnt <= bestCnt) {
        let as = ptrOf[id];
        for (;;) {
          let np = next[as];
          let bs = bPtr;
          let ae = as;
          let be = bs;
          let rc = cnt;
          while (line1 < as && line2 < bs && ids1[as - 2] === ids2[bs - 2]) {
            as--;
            bs--;
            if (rc > 1) rc = Math.min(rc, cntOf[ids1[as - 1]]);
          }
          while (ae < end1 && be < end2 && ids1[ae] === ids2[be]) {
            ae++;
            be++;
            if (rc > 1) rc = Math.min(rc, cntOf[ids1[ae - 1]]);
          }
          if (bNext <= be) bNext = be + 1;
          if (lcs.end1 - lcs.begin1 < ae - as || rc < bestCnt) {
            lcs.begin1 = as;
            lcs.begin2 = bs;
            lcs.end1 = ae;
            lcs.end2 = be;
            bestCnt = rc;
          }
          if (np === 0) break;
          while (np <= ae) {
            np = next[np];
            if (np === 0) break;
          }
          if (np === 0) break;
          as = np;
        }
      }
    }
    bPtr = bNext;
  }

  if (hasCommon && bestCnt > MAX_CHAIN_LENGTH) return FALL_BACK;
  if (lcs.begin1 === 0 && lcs.begin2 === 0) return NOTHING_IN_COMMON;
  return FOUND;
}
