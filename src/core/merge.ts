/**
 * Three-way merge, after git's xdl_merge (xdiff/xmerge.c): the merge behind
 * `git merge-file`, and, through ll-merge, behind `git merge`, cherry-pick,
 * rebase and stash.
 *
 * Each side is diffed against the base. Changes that do not overlap are
 * taken as they are; changes that overlap become conflicts, unless both
 * sides made the same change. At the zealous levels the two sides of each
 * conflict are then diffed against each other, so that only the lines that
 * really differ stay in conflict.
 */

import type { Deadline } from './env.ts';
import { buildScript, diffSides, type Algorithm } from './engine.ts';
import type { Change } from './emit.ts';
import { classify, isSpace, type Side, type WhitespaceFlags } from './lines.ts';

/** How hard to shrink conflicts (git's XDL_MERGE_* levels). */
export const MINIMAL = 0;
export const EAGER = 1;
export const ZEALOUS = 2;
export const ZEALOUS_ALNUM = 3;

/** How a conflict is written. */
export const STYLE_MERGE = 0;
export const STYLE_DIFF3 = 1;
export const STYLE_ZDIFF3 = 2;

/** Which side a conflict resolves to, if any. */
export const FAVOR_NONE = 0;
export const FAVOR_OURS = 1;
export const FAVOR_THEIRS = 2;
export const FAVOR_UNION = 3;

export interface MergeEngineOptions extends WhitespaceFlags {
  algorithm: Algorithm;
  level: number;
  style: number;
  favor: number;
  markerSize: number;
  /** Labels after the markers, in the same mode as the texts; null for none. */
  ours: string | null;
  base: string | null;
  theirs: string | null;
  /** The git release to imitate (see compat.ts). */
  git: number;
  deadline: Deadline;
}

/**
 * A region of the result. i0/chg0 are base records, i1/chg1 records of our
 * side, i2/chg2 records of theirs.
 */
interface Region {
  /** 0 conflict, 1 take ours, 2 take theirs, 3 take both, 4 same change on both sides. */
  mode: number;
  i0: number;
  chg0: number;
  i1: number;
  chg1: number;
  i2: number;
  chg2: number;
}

export interface MergeOutput {
  /** The result, in pieces: joining them is left to the caller. */
  parts: string[];
  conflicts: number;
}

export function merge3(baseText: string, oursText: string, theirsText: string, opts: MergeEngineOptions): MergeOutput {
  const [base, ours, script1] = diffTexts(baseText, oursText, opts);
  const [, theirs, script2] = diffTexts(baseText, theirsText, opts);

  // When one side changed nothing, the other side is the result, byte for
  // byte (under whitespace options, "nothing" is whitespace-blind).
  if (script1.length === 0) return { parts: [theirsText], conflicts: 0 };
  if (script2.length === 0) return { parts: [oursText], conflicts: 0 };

  let level = opts.level;
  // diff3-style output shows the base, so it cannot also rewrite conflicts
  // by comparing the two sides with each other.
  if (opts.style !== STYLE_MERGE && level > EAGER) level = EAGER;

  let regions = collect(script1, script2, base, ours, theirs, level, opts);
  if (opts.style === STYLE_ZDIFF3) {
    trimConflicts(regions, ours, theirs, opts);
  } else if (level >= ZEALOUS) {
    regions = refineConflicts(regions, ours, theirs, opts);
    regions = simplifyNonConflicts(regions, ours, level > ZEALOUS);
  }
  return write(regions, base, ours, theirs, opts);
}

/** Diff and compact, as xdl_merge does: no indent heuristic, ever. */
function diffTexts(a: string, b: string, opts: MergeEngineOptions): [Side, Side, Change[]] {
  const c = classify(a, b, opts);
  const [ca, cb] = diffSides(c.a, c.b, c.classes, opts.algorithm, {
    indentHeuristic: false,
    anchors: [],
    git: opts.git,
    deadline: opts.deadline,
  });
  return [c.a, c.b, buildScript(c.a, c.b, ca, cb)];
}

/** git's xdl_append_merge: start a region, or grow the last one if they overlap. */
function append(list: Region[], mode: number, i0: number, chg0: number, i1: number, chg1: number, i2: number, chg2: number): void {
  const m = list[list.length - 1];
  if (m !== undefined && (i1 <= m.i1 + m.chg1 || i2 <= m.i2 + m.chg2)) {
    if (mode !== m.mode) m.mode = 0;
    m.chg0 = i0 + chg0 - m.i0;
    m.chg1 = i1 + chg1 - m.i1;
    m.chg2 = i2 + chg2 - m.i2;
  } else {
    list.push({ mode, i0, chg0, i1, chg1, i2, chg2 });
  }
}

/**
 * Walk both edit scripts over the base in step. In a script, i1/chg1 is the
 * base range and i2/chg2 the range on that script's side.
 */
function collect(s1: Change[], s2: Change[], base: Side, ours: Side, theirs: Side, level: number, opts: MergeEngineOptions): Region[] {
  const regions: Region[] = [];
  let p1 = 0;
  let p2 = 0;
  while (p1 < s1.length && p2 < s2.length) {
    const x1 = s1[p1];
    const x2 = s2[p2];
    if (x1.i1 + x1.chg1 < x2.i1) {
      append(regions, 1, x1.i1, x1.chg1, x1.i2, x1.chg2, x2.i2 - x2.i1 + x1.i1, x1.chg1);
      p1++;
      continue;
    }
    if (x2.i1 + x2.chg1 < x1.i1) {
      append(regions, 2, x2.i1, x2.chg1, x1.i2 - x1.i1 + x2.i1, x2.chg1, x2.i2, x2.chg2);
      p2++;
      continue;
    }
    if (level === MINIMAL || x1.i1 !== x2.i1 || x1.chg1 !== x2.chg1 || x1.chg2 !== x2.chg2 ||
        !sameRecords(ours, x1.i2, theirs, x2.i2, x1.chg2, opts)) {
      // Overlapping, different changes: one conflict that spans both. On
      // the base, our change starts startGap lines after theirs (before it
      // if negative) and ends endGap lines after theirs; each side's range
      // is widened by the lines of the other's change it does not cover.
      const startGap = x1.i1 - x2.i1;
      const endGap = startGap + x1.chg1 - x2.chg1;
      let i0 = x1.i1;
      let i1 = x1.i2;
      let i2 = x2.i2;
      if (startGap > 0) {
        i0 -= startGap;
        i1 -= startGap;
      } else {
        i2 += startGap;
      }
      let chg0 = x1.i1 + x1.chg1 - i0;
      let chg1 = x1.i2 + x1.chg2 - i1;
      let chg2 = x2.i2 + x2.chg2 - i2;
      if (endGap < 0) {
        chg0 -= endGap;
        chg1 -= endGap;
      } else {
        chg2 += endGap;
      }
      append(regions, 0, i0, chg0, i1, chg1, i2, chg2);
    }
    const end1 = x1.i1 + x1.chg1;
    const end2 = x2.i1 + x2.chg1;
    if (end1 >= end2) p2++;
    if (end2 >= end1) p1++;
  }
  for (; p1 < s1.length; p1++) {
    const x1 = s1[p1];
    append(regions, 1, x1.i1, x1.chg1, x1.i2, x1.chg2, x1.i1 + theirs.n - base.n, x1.chg1);
  }
  for (; p2 < s2.length; p2++) {
    const x2 = s2[p2];
    append(regions, 2, x2.i1, x2.chg1, x2.i1 + ours.n - base.n, x2.chg1, x2.i2, x2.chg2);
  }
  return regions;
}

function record(side: Side, i: number): string {
  return side.text.slice(side.starts[i], side.starts[i + 1]);
}

function sameRecords(x: Side, i: number, y: Side, j: number, count: number, flags: WhitespaceFlags): boolean {
  for (let k = 0; k < count; k++) {
    if (!recordsMatch(record(x, i + k), record(y, j + k), flags)) return false;
  }
  return true;
}

/**
 * git's xdl_recmatch: whether two records, line breaks included, are the
 * same line under the whitespace options. Merging compares the two sides'
 * changes with this directly, not through the classes of a diff.
 */
export function recordsMatch(l1: string, l2: string, flags: WhitespaceFlags): boolean {
  if (l1 === l2) return true;
  const s1 = l1.length;
  const s2 = l2.length;
  let i1 = 0;
  let i2 = 0;
  if (flags.ignoreWhitespace) {
    for (;;) {
      while (i1 < s1 && isSpace(l1.charCodeAt(i1))) i1++;
      while (i2 < s2 && isSpace(l2.charCodeAt(i2))) i2++;
      if (i1 >= s1 || i2 >= s2) break;
      if (l1.charCodeAt(i1++) !== l2.charCodeAt(i2++)) return false;
    }
  } else if (flags.ignoreWhitespaceChange) {
    while (i1 < s1 && i2 < s2) {
      if (isSpace(l1.charCodeAt(i1)) && isSpace(l2.charCodeAt(i2))) {
        while (i1 < s1 && isSpace(l1.charCodeAt(i1))) i1++;
        while (i2 < s2 && isSpace(l2.charCodeAt(i2))) i2++;
        continue;
      }
      if (l1.charCodeAt(i1++) !== l2.charCodeAt(i2++)) return false;
    }
  } else if (flags.ignoreWhitespaceAtEol) {
    while (i1 < s1 && i2 < s2 && l1.charCodeAt(i1) === l2.charCodeAt(i2)) {
      i1++;
      i2++;
    }
  } else if (flags.ignoreCrAtEol) {
    while (i1 < s1 && i2 < s2 && l1.charCodeAt(i1) === l2.charCodeAt(i2)) {
      i1++;
      i2++;
    }
    return endsWithOptionalCr(l1, i1) && endsWithOptionalCr(l2, i2);
  } else {
    return false;
  }
  // Once one side runs out, the rest of the other must be whitespace.
  while (i1 < s1 && isSpace(l1.charCodeAt(i1))) i1++;
  if (i1 < s1) return false;
  while (i2 < s2 && isSpace(l2.charCodeAt(i2))) i2++;
  return i2 === s2;
}

/** Whether a record ends at `i`, allowing a CR before its line break. */
function endsWithOptionalCr(l: string, i: number): boolean {
  let s = l.length;
  const complete = s > 0 && l.charCodeAt(s - 1) === 10;
  if (complete) s--;
  if (s === i) return true;
  // A CR at the end of a last line without a line break is not ignored.
  return complete && s === i + 1 && l.charCodeAt(i) === 13;
}

/**
 * Shrink each conflict to the lines that differ, by diffing our side of it
 * against theirs. A conflict can split into several, or turn out to be the
 * same change on both sides.
 */
function refineConflicts(regions: Region[], ours: Side, theirs: Side, opts: MergeEngineOptions): Region[] {
  const out: Region[] = [];
  for (const m of regions) {
    // There is nothing to refine when one side of the conflict is empty.
    if (m.mode !== 0 || m.chg1 === 0 || m.chg2 === 0) {
      out.push(m);
      continue;
    }
    opts.deadline.check();
    const t1 = ours.text.slice(ours.starts[m.i1], ours.starts[m.i1 + m.chg1]);
    const t2 = theirs.text.slice(theirs.starts[m.i2], theirs.starts[m.i2 + m.chg2]);
    const [, , script] = diffTexts(t1, t2, opts);
    if (script.length === 0) {
      m.mode = 4;
      out.push(m);
      continue;
    }
    for (const x of script) {
      out.push({ mode: 0, i0: m.i0, chg0: m.chg0, i1: x.i1 + m.i1, chg1: x.chg1, i2: x.i2 + m.i2, chg2: x.chg2 });
    }
  }
  return out;
}

function hasAlnum(side: Side, i: number, count: number): boolean {
  const text = side.text;
  for (let k = side.starts[i], end = side.starts[i + count]; k < end; k++) {
    const c = text.charCodeAt(k);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
  }
  return false;
}

/**
 * Join conflicts separated by three lines or fewer, which reads more simply
 * than two conflicts. With `alnum`, also join across any number of lines
 * that hold no letter or digit, such as closing braces.
 */
function simplifyNonConflicts(regions: Region[], ours: Side, alnum: boolean): Region[] {
  const out: Region[] = [];
  for (const r of regions) {
    const m = out[out.length - 1];
    if (m !== undefined && m.mode === 0 && r.mode === 0) {
      const begin = m.i1 + m.chg1;
      const end = r.i1;
      if (!(end - begin > 3 && (!alnum || hasAlnum(ours, begin, end - begin)))) {
        m.chg1 = r.i1 + r.chg1 - m.i1;
        m.chg2 = r.i2 + r.chg2 - m.i2;
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

/** zdiff3: move lines both sides share at the edges of a conflict out of it. */
function trimConflicts(regions: Region[], ours: Side, theirs: Side, flags: WhitespaceFlags): void {
  for (const m of regions) {
    if (m.mode !== 0) continue;
    while (m.chg1 > 0 && m.chg2 > 0 && recordsMatch(record(ours, m.i1), record(theirs, m.i2), flags)) {
      m.chg1--;
      m.chg2--;
      m.i1++;
      m.i2++;
    }
    while (m.chg1 > 0 && m.chg2 > 0 &&
           recordsMatch(record(ours, m.i1 + m.chg1 - 1), record(theirs, m.i2 + m.chg2 - 1), flags)) {
      m.chg1--;
      m.chg2--;
    }
  }
}

/**
 * Whether line `i` ends in CRLF: 1 yes, 0 no, -1 cannot tell. A last line
 * without a line break is judged by the line before it.
 */
function eolIsCrlf(side: Side, i: number): number {
  const n = side.n;
  const crlf = (k: number): number => {
    const size = side.starts[k + 1] - side.starts[k];
    return size > 1 && side.text.charCodeAt(side.starts[k + 1] - 2) === 13 ? 1 : 0;
  };
  if (i < n - 1) return crlf(i);
  if (n === 0) return -1;
  const end = side.starts[i + 1];
  if (end > side.starts[i] && side.text.charCodeAt(end - 1) === 10) return crlf(i);
  if (i === 0) return -1;
  return crlf(i - 1);
}

/** Marker lines follow the line endings around the conflict, as in git. */
function needsCr(base: Side, ours: Side, theirs: Side, m: Region): boolean {
  let cr = eolIsCrlf(ours, m.i1 ? m.i1 - 1 : 0);
  if (cr !== 0) cr = eolIsCrlf(theirs, m.i2 ? m.i2 - 1 : 0);
  if (cr !== 0) cr = eolIsCrlf(base, 0);
  return cr === 1;
}

function write(regions: Region[], base: Side, ours: Side, theirs: Side, opts: MergeEngineOptions): MergeOutput {
  const parts: string[] = [];
  const copy = (side: Side, i: number, count: number, cr: boolean, addNewline: boolean): void => {
    if (count < 1) return;
    const end = side.starts[i + count];
    parts.push(side.text.slice(side.starts[i], end));
    // A side whose last line has no line break gets one, so that the next
    // marker starts on a line of its own.
    if (addNewline && side.text.charCodeAt(end - 1) !== 10) parts.push(cr ? '\r\n' : '\n');
  };
  // Before git 2.55 an empty label still put a space after the marker.
  const labelled = (name: string | null): boolean => name !== null && (name !== '' || opts.git < 255);
  const marker = (ch: string, name: string | null, cr: boolean): void => {
    parts.push(ch.repeat(opts.markerSize) + (labelled(name) ? ' ' + name : '') + (cr ? '\r\n' : '\n'));
  };

  let conflicts = 0;
  let i = 0;
  for (const m of regions) {
    if (opts.favor !== FAVOR_NONE && m.mode === 0) m.mode = opts.favor;
    if (m.mode === 0) {
      conflicts++;
      const cr = needsCr(base, ours, theirs, m);
      copy(ours, i, m.i1 - i, false, false);
      marker('<', opts.ours, cr);
      copy(ours, m.i1, m.chg1, cr, true);
      if (opts.style !== STYLE_MERGE) {
        marker('|', opts.base, cr);
        copy(base, m.i0, m.chg0, cr, true);
      }
      marker('=', null, cr);
      copy(theirs, m.i2, m.chg2, cr, true);
      marker('>', opts.theirs, cr);
    } else if (m.mode & 3) {
      copy(ours, i, m.i1 - i, false, false);
      if (m.mode & 1) copy(ours, m.i1, m.chg1, needsCr(base, ours, theirs, m), (m.mode & 2) !== 0);
      if (m.mode & 2) copy(theirs, m.i2, m.chg2, false, false);
    } else {
      // The same change on both sides: ours, copied with what follows.
      continue;
    }
    i = m.i1 + m.chg1;
  }
  copy(ours, i, ours.n - i, false, false);
  return { parts, conflicts };
}
