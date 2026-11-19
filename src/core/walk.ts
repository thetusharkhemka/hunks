/**
 * Walk the lines of a hunk in the order git prints them.
 */

import type { Change, RawHunk } from './emit.ts';
import type { Side } from './lines.ts';

export const CONTEXT = 0;
export const REMOVED = 1;
export const ADDED = 2;

/**
 * Calls `visit(kind, side, record)` for every line of the hunk. Context is
 * taken from the second side, as git does: under whitespace options the two
 * versions of an unchanged line may differ, and the new one is shown.
 */
export function walkHunk(
  a: Side, b: Side, changes: Change[], h: RawHunk,
  visit: (kind: number, side: Side, i: number, other: number) => void,
): void {
  const first = changes[h.first];
  let s1 = h.s1;
  let s2 = h.s2;
  for (; s2 < first.i2; s1++, s2++) visit(CONTEXT, b, s2, s1);

  s1 = first.i1;
  s2 = first.i2;
  for (let k = h.first; ; k++) {
    const ch = changes[k];
    for (; s1 < ch.i1 && s2 < ch.i2; s1++, s2++) visit(CONTEXT, b, s2, s1);
    for (s1 = ch.i1; s1 < ch.i1 + ch.chg1; s1++) visit(REMOVED, a, s1, -1);
    for (s2 = ch.i2; s2 < ch.i2 + ch.chg2; s2++) visit(ADDED, b, s2, -1);
    if (k === h.last) break;
    s1 = ch.i1 + ch.chg1;
    s2 = ch.i2 + ch.chg2;
  }

  const last = changes[h.last];
  s1 = last.i1 + last.chg1;
  for (s2 = last.i2 + last.chg2; s2 < h.e2; s1++, s2++) visit(CONTEXT, b, s2, s1);
}
