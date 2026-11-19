/**
 * Myers' O(ND) algorithm, with the preparation passes and cost heuristics
 * that make git's default diff what it is.
 *
 * E. W. Myers, "An O(ND) Difference Algorithm and Its Variations",
 * Algorithmica 1 (1986). The heuristics (discarding lines that cannot match,
 * the "good snake" early exit, the cost cap) follow GNU diff and git's xdiff;
 * matching git's output exactly depends on reproducing all of them.
 */

import type { Env } from './env.ts';
import type { Side } from './lines.ts';

/** Integer square root approximation used by git to size its limits. */
export function bogosqrt(n: number): number {
  let i = 1;
  while (n > 0) {
    i *= 2;
    n = Math.floor(n / 4);
  }
  return i;
}

const MAX_COST_MIN = 256;
const HEUR_MIN_COST = 256;
const SNAKE_CNT = 20;
const K_HEUR = 4;
const MAX_EQLIMIT = 1024;
const SIMSCAN_WINDOW = 100;
const KPDIS_RUN = 4;
const LINE_MAX = 0x7fffffff;

const KEEP = 0;
const DISCARD = 1;
const INVESTIGATE = 2;

/**
 * Diff records [off1, off1 + n1) of x against [off2, off2 + n2) of y, marking
 * changed records in cx / cy (indexed by record + 1).
 *
 * This is git's xdl_do_diff() for the Myers algorithm, applied to a range:
 * the histogram and patience algorithms call it for regions they cannot
 * handle, and those calls see the range as if it were a whole file.
 */
export function myers(
  x: Side, y: Side, cx: Uint8Array, cy: Uint8Array,
  off1: number, n1: number, off2: number, n2: number,
  needMin: boolean, env: Env,
): void {
  const ids1 = x.ids;
  const ids2 = y.ids;

  // Common prefix and suffix are never part of the problem.
  const lim = Math.min(n1, n2);
  let pre = 0;
  while (pre < lim && ids1[off1 + pre] === ids2[off2 + pre]) pre++;
  let suf = 0;
  while (suf < lim - pre && ids1[off1 + n1 - 1 - suf] === ids2[off2 + n2 - 1 - suf]) suf++;
  const len1 = n1 - pre - suf;
  const len2 = n2 - pre - suf;
  if (len1 === 0 && len2 === 0) return;

  // Occurrence counts over the whole range, prefix and suffix included.
  const { count1, count2 } = env;
  for (let i = 0; i < n1; i++) count1[ids1[off1 + i]]++;
  for (let i = 0; i < n2; i++) count2[ids2[off2 + i]]++;

  // A line with no partner on the other side is changed, full stop. A line
  // with very many partners is only kept if its neighbourhood suggests it is
  // not just noise in a run of changes.
  const action1 = new Uint8Array(len1);
  const action2 = new Uint8Array(len2);
  const exact = needMin && !env.minimalDiscards;
  const mlim1 = exact ? Infinity : Math.min(bogosqrt(n1), MAX_EQLIMIT);
  const mlim2 = exact ? Infinity : Math.min(bogosqrt(n2), MAX_EQLIMIT);
  for (let i = 0; i < len1; i++) {
    const nm = count2[ids1[off1 + pre + i]];
    action1[i] = nm === 0 ? DISCARD : nm >= mlim1 ? INVESTIGATE : KEEP;
  }
  for (let i = 0; i < len2; i++) {
    const nm = count1[ids2[off2 + pre + i]];
    action2[i] = nm === 0 ? DISCARD : nm >= mlim2 ? INVESTIGATE : KEEP;
  }
  for (let i = 0; i < n1; i++) count1[ids1[off1 + i]] = 0;
  for (let i = 0; i < n2; i++) count2[ids2[off2 + i]] = 0;

  const ha1 = new Int32Array(len1);
  const ha2 = new Int32Array(len2);
  const ri1 = new Int32Array(len1);
  const ri2 = new Int32Array(len2);
  let nreff1 = 0;
  for (let i = 0; i < len1; i++) {
    let a = action1[i];
    if (a === INVESTIGATE) a = discardable(action1, i, len1) ? DISCARD : KEEP;
    const rec = off1 + pre + i;
    if (a === KEEP) {
      ha1[nreff1] = ids1[rec];
      ri1[nreff1++] = rec;
    } else {
      cx[rec + 1] = 1;
    }
  }
  let nreff2 = 0;
  for (let i = 0; i < len2; i++) {
    let a = action2[i];
    if (a === INVESTIGATE) a = discardable(action2, i, len2) ? DISCARD : KEEP;
    const rec = off2 + pre + i;
    if (a === KEEP) {
      ha2[nreff2] = ids2[rec];
      ri2[nreff2++] = rec;
    } else {
      cy[rec + 1] = 1;
    }
  }

  compare(ha1, nreff1, ri1, cx, ha2, nreff2, ri2, cy, needMin, env);
}

/**
 * Should a line with many matches be discarded? Only when it sits inside a
 * run dominated by lines that have no match at all.
 */
function discardable(action: Uint8Array, i: number, len: number): boolean {
  const s = Math.max(0, i - SIMSCAN_WINDOW);
  const e = Math.min(len - 1, i + SIMSCAN_WINDOW);

  let rdis0 = 0;
  let rpdis0 = 1;
  for (let r = 1; i - r >= s; r++) {
    const a = action[i - r];
    if (a === DISCARD) rdis0++;
    else if (a === INVESTIGATE) rpdis0++;
    else break;
  }
  if (rdis0 === 0) return false;

  let rdis1 = 0;
  let rpdis1 = 1;
  for (let r = 1; i + r <= e; r++) {
    const a = action[i + r];
    if (a === DISCARD) rdis1++;
    else if (a === INVESTIGATE) rpdis1++;
    else break;
  }
  if (rdis1 === 0) return false;

  rdis1 += rdis0;
  rpdis1 += rpdis0;
  return rpdis1 * KPDIS_RUN < rpdis1 + rdis1;
}

// Result of split(), kept in module scope to avoid an allocation per call.
let splitI1 = 0;
let splitI2 = 0;
let splitMinLo = false;
let splitMinHi = false;

/**
 * Divide and conquer over the reduced sequences. git recurses; we keep an
 * explicit stack so that pathological inputs cannot overflow the call stack.
 */
function compare(
  ha1: Int32Array, nrec1: number, ri1: Int32Array, cx: Uint8Array,
  ha2: Int32Array, nrec2: number, ri2: Int32Array, cy: Uint8Array,
  needMin: boolean, env: Env,
): void {
  const ndiags = nrec1 + nrec2 + 3;
  const kvd = new Int32Array(2 * ndiags + 2);
  const fbase = nrec2 + 1;
  const bbase = ndiags + nrec2 + 1;
  const mxcost = Math.max(bogosqrt(ndiags), MAX_COST_MIN);

  const stack: number[] = [0, nrec1, 0, nrec2, needMin ? 1 : 0];
  while (stack.length > 0) {
    const min = stack.pop()! === 1;
    let lim2 = stack.pop()!;
    let off2 = stack.pop()!;
    let lim1 = stack.pop()!;
    let off1 = stack.pop()!;

    while (off1 < lim1 && off2 < lim2 && ha1[off1] === ha2[off2]) {
      off1++;
      off2++;
    }
    while (off1 < lim1 && off2 < lim2 && ha1[lim1 - 1] === ha2[lim2 - 1]) {
      lim1--;
      lim2--;
    }

    if (off1 === lim1) {
      for (; off2 < lim2; off2++) cy[ri2[off2] + 1] = 1;
    } else if (off2 === lim2) {
      for (; off1 < lim1; off1++) cx[ri1[off1] + 1] = 1;
    } else {
      split(ha1, off1, lim1, ha2, off2, lim2, kvd, fbase, bbase, min, mxcost, env);
      const i1 = splitI1;
      const i2 = splitI2;
      const lo = splitMinLo;
      const hi = splitMinHi;
      stack.push(i1, lim1, i2, lim2, hi ? 1 : 0);
      stack.push(off1, i1, off2, i2, lo ? 1 : 0);
    }
  }
}

/**
 * Find the middle snake of the box (off1, off2)-(lim1, lim2), scanning
 * forward from the top-left and backward from the bottom-right until the
 * paths meet. If that gets expensive, settle for a good-enough split.
 */
function split(
  ha1: Int32Array, off1: number, lim1: number,
  ha2: Int32Array, off2: number, lim2: number,
  kvd: Int32Array, fbase: number, bbase: number,
  needMin: boolean, mxcost: number, env: Env,
): void {
  const dmin = off1 - lim2;
  const dmax = lim1 - off2;
  const fmid = off1 - off2;
  const bmid = lim1 - lim2;
  const odd = ((fmid - bmid) & 1) !== 0;
  let fmin = fmid;
  let fmax = fmid;
  let bmin = bmid;
  let bmax = bmid;

  kvd[fbase + fmid] = off1;
  kvd[bbase + bmid] = lim1;

  for (let ec = 1; ; ec++) {
    let gotSnake = false;
    // Without a cost cap (--minimal) the search is quadratic; keep the time
    // limit in view.
    if ((ec & 63) === 0) env.check();

    // Extend the forward diagonal domain by one, bouncing off the box edges.
    if (fmin > dmin) kvd[fbase + --fmin - 1] = -1;
    else ++fmin;
    if (fmax < dmax) kvd[fbase + ++fmax + 1] = -1;
    else --fmax;

    for (let d = fmax; d >= fmin; d -= 2) {
      let i1: number;
      if (kvd[fbase + d - 1] >= kvd[fbase + d + 1]) i1 = kvd[fbase + d - 1] + 1;
      else i1 = kvd[fbase + d + 1];
      const prev1 = i1;
      let i2 = i1 - d;
      while (i1 < lim1 && i2 < lim2 && ha1[i1] === ha2[i2]) {
        i1++;
        i2++;
      }
      if (i1 - prev1 > SNAKE_CNT) gotSnake = true;
      kvd[fbase + d] = i1;
      if (odd && bmin <= d && d <= bmax && kvd[bbase + d] <= i1) {
        splitI1 = i1;
        splitI2 = i2;
        splitMinLo = splitMinHi = true;
        return;
      }
    }

    // And the backward one.
    if (bmin > dmin) kvd[bbase + --bmin - 1] = LINE_MAX;
    else ++bmin;
    if (bmax < dmax) kvd[bbase + ++bmax + 1] = LINE_MAX;
    else --bmax;

    for (let d = bmax; d >= bmin; d -= 2) {
      let i1: number;
      if (kvd[bbase + d - 1] < kvd[bbase + d + 1]) i1 = kvd[bbase + d - 1];
      else i1 = kvd[bbase + d + 1] - 1;
      const prev1 = i1;
      let i2 = i1 - d;
      while (i1 > off1 && i2 > off2 && ha1[i1 - 1] === ha2[i2 - 1]) {
        i1--;
        i2--;
      }
      if (prev1 - i1 > SNAKE_CNT) gotSnake = true;
      kvd[bbase + d] = i1;
      if (!odd && fmin <= d && d <= fmax && i1 <= kvd[fbase + d]) {
        splitI1 = i1;
        splitI2 = i2;
        splitMinLo = splitMinHi = true;
        return;
      }
    }

    if (needMin) continue;

    // Past a certain cost, a long diagonal run ("snake") that has travelled
    // far from the corner is taken as a split point rather than searching
    // on for the optimal one.
    if (gotSnake && ec > HEUR_MIN_COST) {
      let best = 0;
      for (let d = fmax; d >= fmin; d -= 2) {
        const dd = d > fmid ? d - fmid : fmid - d;
        const i1 = kvd[fbase + d];
        const i2 = i1 - d;
        const v = i1 - off1 + (i2 - off2) - dd;
        if (v > K_HEUR * ec && v > best &&
            off1 + SNAKE_CNT <= i1 && i1 < lim1 &&
            off2 + SNAKE_CNT <= i2 && i2 < lim2) {
          for (let k = 1; ha1[i1 - k] === ha2[i2 - k]; k++) {
            if (k === SNAKE_CNT) {
              best = v;
              splitI1 = i1;
              splitI2 = i2;
              break;
            }
          }
        }
      }
      if (best > 0) {
        splitMinLo = true;
        splitMinHi = false;
        return;
      }

      best = 0;
      for (let d = bmax; d >= bmin; d -= 2) {
        const dd = d > bmid ? d - bmid : bmid - d;
        const i1 = kvd[bbase + d];
        const i2 = i1 - d;
        const v = lim1 - i1 + (lim2 - i2) - dd;
        if (v > K_HEUR * ec && v > best &&
            off1 < i1 && i1 <= lim1 - SNAKE_CNT &&
            off2 < i2 && i2 <= lim2 - SNAKE_CNT) {
          for (let k = 0; ha1[i1 + k] === ha2[i2 + k]; k++) {
            if (k === SNAKE_CNT - 1) {
              best = v;
              splitI1 = i1;
              splitI2 = i2;
              break;
            }
          }
        }
      }
      if (best > 0) {
        splitMinLo = false;
        splitMinHi = true;
        return;
      }
    }

    // Enough. Take whichever path, forward or backward, got furthest.
    if (ec >= mxcost) {
      let fbest = -1;
      let fbest1 = -1;
      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = Math.min(kvd[fbase + d], lim1);
        let i2 = i1 - d;
        if (lim2 < i2) {
          i1 = lim2 + d;
          i2 = lim2;
        }
        if (fbest < i1 + i2) {
          fbest = i1 + i2;
          fbest1 = i1;
        }
      }

      let bbest = LINE_MAX;
      let bbest1 = LINE_MAX;
      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = Math.max(off1, kvd[bbase + d]);
        let i2 = i1 - d;
        if (i2 < off2) {
          i1 = off2 + d;
          i2 = off2;
        }
        if (i1 + i2 < bbest) {
          bbest = i1 + i2;
          bbest1 = i1;
        }
      }

      if (lim1 + lim2 - bbest < fbest - (off1 + off2)) {
        splitI1 = fbest1;
        splitI2 = fbest - fbest1;
        splitMinLo = true;
        splitMinHi = false;
      } else {
        splitI1 = bbest1;
        splitI2 = bbest - bbest1;
        splitMinLo = false;
        splitMinHi = true;
      }
      return;
    }
  }
}
