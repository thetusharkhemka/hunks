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
 */

import type { Side } from './lines.ts';
import { myers, type MyersEnv } from './myers.ts';

/** More occurrences than this and a line is too common to anchor on. */
const MAX_CHAIN_LENGTH = 64;

interface Occurrences {
  /** First (lowest) line where this element occurs. */
  ptr: number;
  /** How many times it occurs in the indexed range. */
  cnt: number;
}

export interface HistogramContext {
  a: Side;
  b: Side;
  ca: Uint8Array;
  cb: Uint8Array;
  needMin: boolean;
  env: MyersEnv;
}

/** Diff 1-based line ranges, as git does. */
export function histogram(ctx: HistogramContext, line1: number, count1: number, line2: number, count2: number): void {
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
      const lcs = findLcs(ctx, l1, c1, l2, c2);
      if (lcs === FALL_BACK) {
        myers(ctx.a, ctx.b, ctx.ca, ctx.cb, l1 - 1, c1, l2 - 1, c2, ctx.needMin, ctx.env);
        break;
      }
      if (lcs.begin1 === 0 && lcs.begin2 === 0) {
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

interface Region {
  begin1: number;
  end1: number;
  begin2: number;
  end2: number;
}

const FALL_BACK = null;

/**
 * Find the longest common region whose rarest line is as rare as possible.
 * Returns FALL_BACK when the inputs share lines but all are too common.
 */
function findLcs(ctx: HistogramContext, line1: number, count1: number, line2: number, count2: number): Region | typeof FALL_BACK {
  const ids1 = ctx.a.ids;
  const ids2 = ctx.b.ids;
  const end1 = line1 + count1 - 1;
  const end2 = line2 + count2 - 1;

  // Index the first range. Scanning backwards leaves each element's
  // occurrence chain in ascending order.
  const records = new Map<number, Occurrences>();
  const lineMap: Occurrences[] = new Array(count1);
  const nextPtrs = new Int32Array(count1);
  for (let ptr = end1; ptr >= line1; ptr--) {
    const id = ids1[ptr - 1];
    let rec = records.get(id);
    if (rec) {
      nextPtrs[ptr - line1] = rec.ptr;
      rec.ptr = ptr;
      rec.cnt++;
    } else {
      rec = { ptr, cnt: 1 };
      records.set(id, rec);
    }
    lineMap[ptr - line1] = rec;
  }

  const lcs: Region = { begin1: 0, end1: 0, begin2: 0, end2: 0 };
  let bestCnt = MAX_CHAIN_LENGTH + 1;
  let hasCommon = false;

  for (let bPtr = line2; bPtr <= end2;) {
    let bNext = bPtr + 1;
    const rec = records.get(ids2[bPtr - 1]);
    if (rec) {
      if (rec.cnt > bestCnt) {
        hasCommon = true;
      } else {
        hasCommon = true;
        let as = rec.ptr;
        for (;;) {
          let np = nextPtrs[as - line1];
          let bs = bPtr;
          let ae = as;
          let be = bs;
          let rc = rec.cnt;
          while (line1 < as && line2 < bs && ids1[as - 2] === ids2[bs - 2]) {
            as--;
            bs--;
            if (rc > 1) rc = Math.min(rc, lineMap[as - line1].cnt);
          }
          while (ae < end1 && be < end2 && ids1[ae] === ids2[be]) {
            ae++;
            be++;
            if (rc > 1) rc = Math.min(rc, lineMap[ae - line1].cnt);
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
            np = nextPtrs[np - line1];
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
  return lcs;
}
