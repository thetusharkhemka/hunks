/**
 * The pipeline: classify, diff, compact, build the edit script.
 */

import { compact } from './compact.ts';
import type { Change } from './emit.ts';
import { histogram } from './histogram.ts';
import { classify, isBlankRecord, recordContent, type Side, type WhitespaceFlags } from './lines.ts';
import { textOf } from './utf8.ts';
import { Env, type Deadline } from './env.ts';
import { myers } from './myers.ts';
import { patience } from './patience.ts';

export type Algorithm = 'myers' | 'minimal' | 'patience' | 'histogram';

export interface EngineOptions extends WhitespaceFlags {
  algorithm: Algorithm;
  indentHeuristic: boolean;
  anchors: readonly string[];
  ignoreBlankLines: boolean;
  ignoreMatchingLines: readonly RegExp[];
  /** The git release to imitate (see compat.ts). */
  git: number;
  /** When to give up with DiffTimeoutError. */
  deadline: Deadline;
}

export interface EngineResult {
  a: Side;
  b: Side;
  changes: Change[];
}

/** Mark changed records on both sides of an already classified pair. */
export function diffSides(a: Side, b: Side, classes: number, algorithm: Algorithm, opts: {
  indentHeuristic: boolean;
  anchors: readonly string[];
  git: number;
  /** Also minimal, as patience with --minimal was before git 2.53. */
  minimal?: boolean;
  deadline?: Deadline;
}): [Uint8Array, Uint8Array] {
  const ca = new Uint8Array(a.n + 2);
  const cb = new Uint8Array(b.n + 2);
  const env = new Env(classes, { minimalDiscards: opts.git < 250, deadline: opts.deadline });
  const needMin = algorithm === 'minimal' || !!opts.minimal;

  if (algorithm === 'patience') {
    patience({ a, b, ca, cb, needMin, env, anchors: opts.anchors, legacy: opts.git < 254 }, 1, a.n, 1, b.n);
  } else if (algorithm === 'histogram') {
    histogram({ a, b, ca, cb, needMin, env }, 1, a.n, 1, b.n);
  } else {
    myers(a, b, ca, cb, 0, a.n, 0, b.n, needMin, env);
  }

  const compaction = {
    indentHeuristic: opts.indentHeuristic,
    rediff: algorithm === 'histogram' && opts.git >= 254,
    needMin,
    env,
  };
  compact(a, ca, b, cb, compaction);
  compact(b, cb, a, ca, compaction);
  return [ca, cb];
}

/** Turn changed-record marks into a list of changes, in order. */
export function buildScript(a: Side, b: Side, ca: Uint8Array, cb: Uint8Array): Change[] {
  const changes: Change[] = [];
  let i1 = 0;
  let i2 = 0;
  while (i1 < a.n || i2 < b.n) {
    if (ca[i1 + 1] || cb[i2 + 1]) {
      const s1 = i1;
      const s2 = i2;
      while (ca[i1 + 1]) i1++;
      while (cb[i2 + 1]) i2++;
      changes.push({ i1: s1, i2: s2, chg1: i1 - s1, chg2: i2 - s2, ignore: false });
    } else {
      i1++;
      i2++;
    }
  }
  return changes;
}

export function run(textA: string, textB: string, opts: EngineOptions, bytes: boolean): EngineResult {
  const { a, b, classes } = classify(textA, textB, opts);
  const algorithm = opts.anchors.length > 0 ? 'patience' : opts.algorithm;
  // Before git 2.53, --minimal survived the switch to patience that
  // --anchored makes; since then the switch clears it.
  const [ca, cb] = diffSides(a, b, classes, algorithm, { ...opts, minimal: opts.algorithm === 'minimal' && opts.git < 253 });
  const changes = buildScript(a, b, ca, cb);

  if (opts.ignoreBlankLines) {
    for (const ch of changes) {
      let ignore = true;
      for (let i = 0; ignore && i < ch.chg1; i++) ignore = isBlankRecord(a, ch.i1 + i, opts, bytes);
      for (let i = 0; ignore && i < ch.chg2; i++) ignore = isBlankRecord(b, ch.i2 + i, opts, bytes);
      ch.ignore = ignore;
    }
  }
  if (opts.ignoreMatchingLines.length > 0) {
    const matches = (side: Side, i: number): boolean => {
      // Patterns are written as text, so in byte mode they see text too.
      const line = bytes ? textOf(recordContent(side, i)) : recordContent(side, i);
      for (const re of opts.ignoreMatchingLines) {
        re.lastIndex = 0;
        if (re.test(line)) return true;
      }
      return false;
    };
    for (const ch of changes) {
      if (ch.ignore) continue;
      let ignore = true;
      for (let i = 0; ignore && i < ch.chg1; i++) ignore = matches(a, ch.i1 + i);
      for (let i = 0; ignore && i < ch.chg2; i++) ignore = matches(b, ch.i2 + i);
      ch.ignore = ignore;
    }
  }
  return { a, b, changes };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * With no context lines git first drops the common tail of both inputs, in
 * 1 KiB blocks, then gives back enough to end on a whole line. The algorithms
 * then never see those lines, which can move where a change lands; so must we.
 */
export function trimCommonTail(a: string, b: string, bytes: boolean): [string, string] {
  const blk = 1024;
  const A = bytes ? null : encoder.encode(a);
  const B = bytes ? null : encoder.encode(b);
  const sa = A ? A.length : a.length;
  const sb = B ? B.length : b.length;
  const at = A ? (i: number) => A[i] : (i: number) => a.charCodeAt(i);
  const bt = B ? (i: number) => B[i] : (i: number) => b.charCodeAt(i);

  const smaller = Math.min(sa, sb);
  let trimmed = 0;
  outer: while (blk + trimmed <= smaller) {
    for (let k = 1; k <= blk; k++) {
      if (at(sa - trimmed - k) !== bt(sb - trimmed - k)) break outer;
    }
    trimmed += blk;
  }
  let recovered = 0;
  while (recovered < trimmed) {
    if (at(sa - trimmed + recovered++) === 10) break;
  }
  const cut = trimmed - recovered;
  if (cut === 0) return [a, b];
  const tail = A ? decoder.decode(A.subarray(sa - cut)).length : cut;
  return [a.slice(0, a.length - tail), b.slice(0, b.length - tail)];
}
