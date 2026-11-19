/**
 * hunks: git's diff engine, in TypeScript.
 *
 * @module
 */

import { compat } from './core/compat.ts';
import { defaultFuncname, emit, type EmitOptions, type FuncMatcher, type RawHunk } from './core/emit.ts';
import { buildScript, diffSides, run, trimCommonTail, type Algorithm, type EngineOptions } from './core/engine.ts';
import { recordContent, type Side } from './core/lines.ts';
import { fromBytes, headingBytes, hunkHeader } from './core/utf8.ts';
import { CONTEXT, REMOVED, walkHunk } from './core/walk.ts';
import { inlineSpans, type Span } from './inline.ts';

export type { Algorithm } from './core/engine.ts';
export type { Span } from './inline.ts';
export { inlineSpans as inline } from './inline.ts';

/** How lines are compared. Every option corresponds to a `git diff` flag. */
export interface DiffOptions {
  /**
   * `'myers'` (git's default), `'minimal'`, `'patience'` or `'histogram'`.
   * Histogram tends to produce the most readable diffs of source code.
   */
  algorithm?: Algorithm;
  /**
   * Shift ambiguous additions and deletions to the boundaries a person would
   * choose (`--indent-heuristic`). On by default, as in git.
   */
  indentHeuristic?: boolean;
  /** Ignore whitespace entirely (`-w`, `--ignore-all-space`). */
  ignoreWhitespace?: boolean;
  /** Ignore changes in the amount of whitespace (`-b`, `--ignore-space-change`). */
  ignoreWhitespaceChange?: boolean;
  /** Ignore whitespace at line ends (`--ignore-space-at-eol`). */
  ignoreWhitespaceAtEol?: boolean;
  /** Ignore a carriage return at line ends (`--ignore-cr-at-eol`). */
  ignoreCrAtEol?: boolean;
  /** Ignore changes that only add or remove blank lines (`--ignore-blank-lines`). */
  ignoreBlankLines?: boolean;
  /** Ignore changes whose lines all match a pattern (`-I`, `--ignore-matching-lines`). */
  ignoreMatchingLines?: RegExp | readonly RegExp[];
  /**
   * Keep lines starting with this text in the common part of the diff
   * (`--anchored`). Implies the patience algorithm.
   */
  anchored?: string | readonly string[];
}

/** How changes are grouped into hunks. */
export interface HunkOptions extends DiffOptions {
  /** Unchanged lines shown around each change (`-U`). Default `3`. */
  context?: number;
  /** Also merge hunks up to this many lines further apart (`--inter-hunk-context`). Default `0`. */
  interHunkContext?: number;
  /** Extend each hunk to the whole function it touches (`-W`, `--function-context`). */
  functionContext?: boolean;
  /**
   * What is shown after `@@ ... @@`. By default, like git, the nearest line
   * above the hunk that starts with a letter, `_` or `$`. Pass a RegExp to
   * use a pattern instead (the first capture group if there is one, else the
   * whole match), a function to decide yourself, or `false` for nothing.
   */
  funcname?: boolean | RegExp | ((line: string) => string | null | undefined);
}

export interface PatchOptions extends HunkOptions {
  /** Name for the `---` header line. Headers are printed when either name is given. */
  fromFile?: string;
  /** Name for the `+++` header line. */
  toFile?: string;
}

export interface DiffResultOptions extends HunkOptions {
  /** Compute word-level `spans` for removed and added lines. */
  inline?: boolean;
}

/** A contiguous change: 0-based, end-exclusive line ranges, ready for `slice()`. */
export interface Edit {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

export interface Line {
  type: 'context' | 'removed' | 'added';
  /** The line, without its line break. */
  text: string;
  /** 1-based line number in the old text, or null for added lines. */
  oldNumber: number | null;
  /** 1-based line number in the new text, or null for removed lines. */
  newNumber: number | null;
  /** False for a last line that has no line break. */
  newline: boolean;
  /**
   * With `inline: true`, the parts of a removed or added line that differ
   * from its counterpart. Empty when the line is new, or so different from
   * anything on the other side that highlighting would not help.
   */
  spans?: Span[];
}

export interface Hunk {
  /** Numbers as printed in the header: 1-based starts, line counts. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The function name shown after `@@ ... @@`, or `''`. */
  heading: string;
  /** The full `@@ -a,b +c,d @@ heading` line. */
  header: string;
  lines: Line[];
}

export interface Diff {
  hunks: Hunk[];
  /** Lines added and removed across all hunks. */
  added: number;
  removed: number;
}

type Input = string | Uint8Array;

function toText(input: Input): string {
  return typeof input === 'string' ? input : fromBytes(input, true);
}

function list<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
}

function count(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`hunks: ${name} must be a non-negative integer, got ${value}`);
  return value;
}

const ALGORITHMS: readonly string[] = ['myers', 'minimal', 'patience', 'histogram'];

function engineOptions(options: DiffOptions): EngineOptions {
  const algorithm = options.algorithm ?? 'myers';
  if (!ALGORITHMS.includes(algorithm)) throw new TypeError(`hunks: unknown algorithm '${algorithm}'`);
  return {
    algorithm,
    indentHeuristic: options.indentHeuristic ?? true,
    ignoreWhitespace: !!options.ignoreWhitespace,
    ignoreWhitespaceChange: !!options.ignoreWhitespaceChange,
    ignoreWhitespaceAtEol: !!options.ignoreWhitespaceAtEol,
    ignoreCrAtEol: !!options.ignoreCrAtEol,
    ignoreBlankLines: !!options.ignoreBlankLines,
    ignoreMatchingLines: list(options.ignoreMatchingLines),
    anchors: list(options.anchored),
    git: compat.git,
  };
}

function funcMatcher(option: HunkOptions['funcname']): FuncMatcher | null {
  if (option === false) return null;
  if (option === undefined || option === true) return defaultFuncname;
  if (option instanceof RegExp) {
    const re = option;
    return (side, i) => {
      let line = recordContent(side, i);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      re.lastIndex = 0;
      const m = re.exec(line);
      if (!m) return null;
      return m.length > 1 && m[1] !== undefined ? m[1] : m[0];
    };
  }
  const fn = option;
  return (side, i) => {
    const h = fn(recordContent(side, i));
    return h === null || h === undefined ? null : h;
  };
}

interface Prepared {
  a: Side;
  b: Side;
  raw: ReturnType<typeof run>;
  hunks: RawHunk[];
  bytes: boolean;
}

function prepare(oldInput: Input, newInput: Input, options: HunkOptions): Prepared {
  const bytes = typeof oldInput !== 'string' || typeof newInput !== 'string';
  let textA = toText(oldInput);
  let textB = toText(newInput);
  const emitOptions: EmitOptions = {
    context: count(options.context, 3, 'context'),
    interHunkContext: count(options.interHunkContext, 0, 'interHunkContext'),
    functionContext: !!options.functionContext,
    funcname: funcMatcher(options.funcname),
  };
  if (emitOptions.context === 0 && !emitOptions.functionContext) {
    [textA, textB] = trimCommonTail(textA, textB, bytes);
  }
  const raw = run(textA, textB, engineOptions(options), bytes);
  const hunks = emit(raw.a, raw.b, raw.changes, emitOptions);
  return { a: raw.a, b: raw.b, raw, hunks, bytes };
}

function header(h: RawHunk, bytes: boolean): string {
  const heading = h.heading === null ? null : headingBytes(h.heading.slice(0, bytes ? 80 : 81), bytes);
  return hunkHeader(h.s1 + 1, h.e1 - h.s1, h.s2 + 1, h.e2 - h.s2, heading, bytes);
}

const NO_NEWLINE = '\n\\ No newline at end of file\n';

/**
 * A unified diff of `oldText` and `newText`, byte for byte what
 * `git diff --no-index` prints below its header lines.
 *
 * Strings in, string out. Pass `Uint8Array`s to work on raw bytes and get
 * bytes back: then even non-UTF-8 input comes out exactly as git's.
 */
export function patch(oldText: string, newText: string, options?: PatchOptions): string;
export function patch(oldText: Uint8Array, newText: Uint8Array, options?: PatchOptions): Uint8Array;
export function patch(oldText: Input, newText: Input, options: PatchOptions = {}): string | Uint8Array {
  const { a, b, raw, hunks, bytes } = prepare(oldText, newText, options);
  let out = '';
  if (hunks.length > 0 && (options.fromFile !== undefined || options.toFile !== undefined)) {
    out += `--- ${options.fromFile ?? options.toFile}\n+++ ${options.toFile ?? options.fromFile}\n`;
  }
  const parts: string[] = [];
  for (const h of hunks) {
    parts.push(header(h, bytes), '\n');
    walkHunk(a, b, raw.changes, h, (kind, side, i) => {
      const rec = side.text.slice(side.starts[i], side.starts[i + 1]);
      parts.push(kind === CONTEXT ? ' ' : kind === REMOVED ? '-' : '+', rec);
      if (rec.charCodeAt(rec.length - 1) !== 10) parts.push(NO_NEWLINE);
    });
  }
  out += parts.join('');
  if (!bytes) return out;
  const result = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) result[i] = out.charCodeAt(i);
  return result;
}

/**
 * The hunks of a diff, ready to render: every line with its type, text and
 * line numbers, and with `inline: true` the changed words within lines.
 */
export function diff(oldText: string, newText: string, options: DiffResultOptions = {}): Diff {
  const { a, b, raw, hunks } = prepare(oldText, newText, options);
  const result: Diff = { hunks: [], added: 0, removed: 0 };
  for (const h of hunks) {
    const lines: Line[] = [];
    walkHunk(a, b, raw.changes, h, (kind, side, i, other) => {
      const end = side.starts[i + 1];
      const newline = end > side.starts[i] && side.text.charCodeAt(end - 1) === 10;
      const text = side.text.slice(side.starts[i], newline ? end - 1 : end);
      if (kind === CONTEXT) {
        lines.push({ type: 'context', text, oldNumber: other + 1, newNumber: i + 1, newline });
      } else if (kind === REMOVED) {
        result.removed++;
        lines.push({ type: 'removed', text, oldNumber: i + 1, newNumber: null, newline });
      } else {
        result.added++;
        lines.push({ type: 'added', text, oldNumber: null, newNumber: i + 1, newline });
      }
    });
    if (options.inline) addSpans(lines);
    const head = header(h, false);
    const at = head.indexOf(' @@');
    result.hunks.push({
      oldStart: h.e1 - h.s1 ? h.s1 + 1 : h.s1,
      oldLines: h.e1 - h.s1,
      newStart: h.e2 - h.s2 ? h.s2 + 1 : h.s2,
      newLines: h.e2 - h.s2,
      heading: head.length > at + 4 ? head.slice(at + 4) : '',
      header: head,
      lines,
    });
  }
  return result;
}

function addSpans(lines: Line[]): void {
  for (let i = 0; i < lines.length;) {
    if (lines[i].type === 'context') {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].type === 'removed') j++;
    let k = j;
    while (k < lines.length && lines[k].type === 'added') k++;
    const removed = lines.slice(i, j);
    const added = lines.slice(j, k);
    if (removed.length > 0 && added.length > 0) {
      const spans = inlineSpans(removed.map((l) => l.text), added.map((l) => l.text));
      removed.forEach((l, n) => (l.spans = spans.removed[n]));
      added.forEach((l, n) => (l.spans = spans.added[n]));
    } else {
      for (const l of removed) l.spans = [];
      for (const l of added) l.spans = [];
    }
    i = k;
  }
}

/** The line-level edit script that turns `oldText` into `newText`. */
export function edits(oldText: Input, newText: Input, options: DiffOptions = {}): Edit[] {
  const raw = run(toText(oldText), toText(newText), engineOptions(options), typeof oldText !== 'string');
  return raw.changes.map((c) => ({ oldStart: c.i1, oldEnd: c.i1 + c.chg1, newStart: c.i2, newEnd: c.i2 + c.chg2 }));
}

export interface ArrayDiffOptions<T> {
  algorithm?: Algorithm;
  /** Map elements to a value compared with `===`. Defaults to the element itself. */
  key?: (item: T) => unknown;
}

/** The same engine, for any two sequences. */
export function diffArrays<T>(oldItems: readonly T[], newItems: readonly T[], options: ArrayDiffOptions<T> = {}): Edit[] {
  const key = options.key ?? ((x: T) => x);
  const table = new Map<unknown, number>();
  const intern = (x: T): number => {
    const k = key(x);
    let id = table.get(k);
    if (id === undefined) table.set(k, (id = table.size));
    return id;
  };
  const side = (items: readonly T[]): Side => {
    const ids = Int32Array.from(items, intern);
    return { text: '', starts: new Int32Array(ids.length + 1), n: ids.length, ids };
  };
  const a = side(oldItems);
  const b = side(newItems);
  const algorithm = options.algorithm ?? 'myers';
  if (!ALGORITHMS.includes(algorithm)) throw new TypeError(`hunks: unknown algorithm '${algorithm}'`);
  const [ca, cb] = diffSides(a, b, table.size, algorithm, { indentHeuristic: false, anchors: [], git: compat.git });
  return buildScript(a, b, ca, cb).map((c) => ({ oldStart: c.i1, oldEnd: c.i1 + c.chg1, newStart: c.i2, newEnd: c.i2 + c.chg2 }));
}
