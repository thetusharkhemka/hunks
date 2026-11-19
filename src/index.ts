/**
 * hunks: git's diff engine, in TypeScript.
 *
 * @module
 */

import { compat } from './core/compat.ts';
import { Deadline, DiffTimeoutError } from './core/env.ts';
import { fileLine, quotePath } from './core/quote.ts';
import { defaultFuncname, emit, type EmitOptions, type FuncMatcher, type RawHunk } from './core/emit.ts';
import { buildScript, diffSides, run, trimCommonTail, type Algorithm, type EngineOptions } from './core/engine.ts';
import { recordContent, type Side } from './core/lines.ts';
import { byteString, fromBytes, headingBytes, hunkHeader, textOf } from './core/utf8.ts';
import { CONTEXT, REMOVED, walkHunk } from './core/walk.ts';
import { inlineSpans, type Span } from './inline.ts';

export type { Algorithm } from './core/engine.ts';
export { DiffTimeoutError };
export type { Span } from './inline.ts';

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
  /**
   * Give up after this many milliseconds by throwing a `DiffTimeoutError`.
   * Myers and patience grow only a little faster than the input, but
   * histogram and minimal can take quadratic time on input crafted for it,
   * in git as here, and any algorithm takes a while on hundreds of
   * megabytes. Set a limit whenever the input comes from people you don't
   * trust.
   */
  timeout?: number;
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
  /**
   * Label for the `---` line, such as `a/src/app.ts`. Header lines are printed
   * when either label is given. Labels are quoted the way git quotes paths, so
   * a name with a line break or an escape character cannot forge patch lines.
   */
  fromFile?: string;
  /** Label for the `+++` line. */
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

// `instanceof` fails for arrays made in another realm, such as the Buffers
// fs hands to code running under Jest's vm sandbox. This getter reads the
// internal type of any typed array, wherever it was made.
const typedArrayName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!;

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (ArrayBuffer.isView(value) && typedArrayName.call(value) === 'Uint8Array');
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (ArrayBuffer.isView(value)) return typedArrayName.call(value) ?? 'a DataView';
  return typeof value;
}

function checkInput(input: unknown, which: string): asserts input is Input {
  if (typeof input !== 'string' && !isBytes(input)) {
    throw new TypeError(`hunks: ${which} must be a string or a Uint8Array, got ${describe(input)}`);
  }
}

/**
 * The longest string V8 can hold (2^29 - 24 chars). Byte mode holds one byte
 * per char, so this is also the most bytes a side can have: 512 MiB, which
 * is where git stops diffing files as text (core.bigFileThreshold).
 */
const MAX_INPUT = (1 << 29) - 24;
const encoder = new TextEncoder();

function tooLarge(which: string, size: number): RangeError {
  return new RangeError(`hunks: ${which} is ${size} bytes; the limit is ${MAX_INPUT} (512 MiB)`);
}

/** In byte mode every char is one byte, so strings go in as UTF-8. */
function toText(input: Input, bytes: boolean, which: string): string {
  if (typeof input === 'string') {
    if (!bytes) return input;
    const encoded = encoder.encode(input);
    if (encoded.length > MAX_INPUT) throw tooLarge(which, encoded.length);
    return fromBytes(encoded, true);
  }
  if (input.length > MAX_INPUT) throw tooLarge(which, input.length);
  return fromBytes(input, true);
}

function checkOptions(options: unknown): void {
  if (options === null || typeof options !== 'object') throw new TypeError(`hunks: options must be an object, got ${describe(options)}`);
}

function deadline(value: unknown): Deadline {
  if (value === undefined) return new Deadline(Infinity);
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new RangeError(`hunks: timeout must be a positive number of milliseconds, got ${String(value)}`);
  }
  return new Deadline(value);
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

function engineOptions(options: DiffOptions, bytes: boolean, limit: Deadline): EngineOptions {
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
    anchors: bytes ? list(options.anchored).map(byteString) : list(options.anchored),
    git: compat.git,
    deadline: limit,
  };
}

function funcMatcher(option: HunkOptions['funcname'], bytes: boolean): FuncMatcher | null {
  if (option === false) return null;
  if (option === undefined || option === true) return defaultFuncname;
  // A pattern or function works on text; in byte mode the line is decoded
  // for it and its answer encoded again.
  const line = (side: Side, i: number): string => {
    const raw = recordContent(side, i);
    return bytes ? textOf(raw) : raw;
  };
  const back = (h: string): string => (bytes ? byteString(h) : h);
  if (option instanceof RegExp) {
    const re = option;
    return (side, i) => {
      // As git does, match without the line break ("\n" or "\r\n").
      let text = line(side, i);
      if (text.endsWith('\r') && side.starts[i + 1] - side.starts[i] > recordContent(side, i).length) text = text.slice(0, -1);
      re.lastIndex = 0;
      const m = re.exec(text);
      if (!m) return null;
      return back(m.length > 1 && m[1] !== undefined ? m[1] : m[0]);
    };
  }
  if (typeof option !== 'function') throw new TypeError('hunks: funcname must be a boolean, a RegExp or a function');
  const fn = option;
  return (side, i) => {
    const h = fn(line(side, i));
    if (h === null || h === undefined) return null;
    if (typeof h !== 'string') throw new TypeError('hunks: a funcname function must return a string, null or undefined');
    return back(h);
  };
}

interface Prepared {
  a: Side;
  b: Side;
  raw: ReturnType<typeof run>;
  hunks: RawHunk[];
  bytes: boolean;
  limit: Deadline;
}

function prepare(oldInput: unknown, newInput: unknown, options: HunkOptions): Prepared {
  checkInput(oldInput, 'the old text');
  checkInput(newInput, 'the new text');
  checkOptions(options);
  const limit = deadline(options.timeout);
  const bytes = typeof oldInput !== 'string' || typeof newInput !== 'string';
  let textA = toText(oldInput, bytes, 'the old text');
  let textB = toText(newInput, bytes, 'the new text');
  const emitOptions: EmitOptions = {
    context: count(options.context, 3, 'context'),
    interHunkContext: count(options.interHunkContext, 0, 'interHunkContext'),
    functionContext: !!options.functionContext,
    funcname: funcMatcher(options.funcname, bytes),
  };
  if (emitOptions.context === 0 && !emitOptions.functionContext) {
    [textA, textB] = trimCommonTail(textA, textB, bytes);
  }
  const raw = run(textA, textB, engineOptions(options, bytes, limit), bytes);
  const hunks = emit(raw.a, raw.b, raw.changes, emitOptions);
  return { a: raw.a, b: raw.b, raw, hunks, bytes, limit };
}

function header(h: RawHunk, bytes: boolean): string {
  // A heading never spans lines: git takes it from a single line, and a
  // custom funcname must not be able to forge patch lines either.
  let raw = h.heading;
  if (raw !== null) {
    const nl = raw.indexOf('\n');
    if (nl !== -1) raw = raw.slice(0, nl);
  }
  // Only the first 80 bytes of a heading can reach the header; 81 UTF-16
  // units always cover them, including a surrogate pair at the boundary.
  const heading = raw === null ? null : headingBytes(raw.slice(0, bytes ? 80 : 81), bytes);
  return hunkHeader(h.s1 + 1, h.e1 - h.s1, h.s2 + 1, h.e2 - h.s2, heading, bytes);
}

const NO_NEWLINE = '\n\\ No newline at end of file\n';

function label(name: unknown): string {
  if (typeof name !== 'string') throw new TypeError(`hunks: fromFile and toFile must be strings, got ${describe(name)}`);
  return quotePath(name);
}

/**
 * A unified diff of `oldText` and `newText`, byte for byte what
 * `git diff --no-index` prints below its header lines.
 *
 * Strings in, string out. Pass `Uint8Array`s to work on raw bytes and get
 * bytes back: then even non-UTF-8 input comes out exactly as git's.
 */
export function patch(oldText: string, newText: string, options?: PatchOptions): string;
export function patch(oldText: Uint8Array, newText: Uint8Array, options?: PatchOptions): Uint8Array;
/** If either side is bytes, the result is bytes. */
export function patch(oldText: string | Uint8Array, newText: string | Uint8Array, options?: PatchOptions): string | Uint8Array;
export function patch(oldText: Input, newText: Input, options: PatchOptions = {}): string | Uint8Array {
  const { a, b, raw, hunks, bytes } = prepare(oldText, newText, options);
  let out = '';
  if (hunks.length > 0 && (options.fromFile !== undefined || options.toFile !== undefined)) {
    const from = label(options.fromFile ?? options.toFile!);
    const to = label(options.toFile ?? options.fromFile!);
    const names = `${fileLine('---', from)}\n${fileLine('+++', to)}\n`;
    // In byte mode every char is a byte, so names go in as UTF-8.
    out += bytes ? byteString(names) : names;
  }
  const parts: string[] = [out];
  for (const h of hunks) {
    parts.push(header(h, bytes), '\n');
    walkHunk(a, b, raw.changes, h, (kind, side, i) => {
      const rec = side.text.slice(side.starts[i], side.starts[i + 1]);
      parts.push(kind === CONTEXT ? ' ' : kind === REMOVED ? '-' : '+', rec);
      if (rec.charCodeAt(rec.length - 1) !== 10) parts.push(NO_NEWLINE);
    });
  }
  if (!bytes) {
    try {
      return parts.join('');
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      throw new RangeError('hunks: the patch is longer than the longest string JavaScript can hold; pass Uint8Arrays to get it as bytes');
    }
  }
  // Each char is one byte. Copying the parts straight into the result also
  // lets a patch outgrow the longest possible string.
  let size = 0;
  for (const p of parts) size += p.length;
  const result = new Uint8Array(size);
  let k = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) result[k++] = p.charCodeAt(i);
  }
  return result;
}

/**
 * The hunks of a diff, ready to render: every line with its type, text and
 * line numbers, and with `inline: true` the changed words within lines.
 *
 * Bytes are compared exactly, as `patch` compares them, so the hunks are
 * always git's; only the text of each line is then decoded as UTF-8, with
 * U+FFFD standing in for bytes that are not valid UTF-8.
 */
export function diff(oldText: string | Uint8Array, newText: string | Uint8Array, options: DiffResultOptions = {}): Diff {
  const { a, b, raw, hunks, bytes, limit } = prepare(oldText, newText, options);
  const result: Diff = { hunks: [], added: 0, removed: 0 };
  for (const h of hunks) {
    const lines: Line[] = [];
    walkHunk(a, b, raw.changes, h, (kind, side, i, other) => {
      const start = side.starts[i];
      const end = side.starts[i + 1];
      const newline = end > start && side.text.charCodeAt(end - 1) === 10;
      const record = side.text.slice(start, newline ? end - 1 : end);
      const text = bytes ? textOf(record) : record;
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
    if (options.inline) addSpans(lines, limit);
    const head = bytes ? textOf(header(h, true)) : header(h, false);
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

function addSpans(lines: Line[], limit: Deadline): void {
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
      const spans = inlineSpans(removed.map((l) => l.text), added.map((l) => l.text), limit);
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
  checkInput(oldText, 'the old text');
  checkInput(newText, 'the new text');
  checkOptions(options);
  const limit = deadline(options.timeout);
  const bytes = typeof oldText !== 'string' || typeof newText !== 'string';
  const raw = run(toText(oldText, bytes, 'the old text'), toText(newText, bytes, 'the new text'), engineOptions(options, bytes, limit), bytes);
  return raw.changes.map((c) => ({ oldStart: c.i1, oldEnd: c.i1 + c.chg1, newStart: c.i2, newEnd: c.i2 + c.chg2 }));
}

export interface ArrayDiffOptions<T> {
  algorithm?: Algorithm;
  /**
   * Map each element to the value it is compared by. Values are compared the
   * way a Map compares keys: `===`, except that NaN matches NaN. Defaults to
   * the element itself.
   */
  key?: (item: T) => unknown;
  /** As for `diff`: give up after this many milliseconds. */
  timeout?: number;
}

function isSequence(value: unknown): value is ArrayLike<unknown> {
  return Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));
}

/** Any typed array but a DataView; diffArrays compares their elements. */
export type TypedArray =
  | Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array
  | Float32Array | Float64Array | BigInt64Array | BigUint64Array;

/** The same engine, for any two arrays, or two typed arrays. */
export function diffArrays<T>(oldItems: readonly T[], newItems: readonly T[], options?: ArrayDiffOptions<T>): Edit[];
export function diffArrays(oldItems: TypedArray, newItems: TypedArray, options?: ArrayDiffOptions<number | bigint>): Edit[];
export function diffArrays<T>(oldItems: readonly T[] | TypedArray, newItems: readonly T[] | TypedArray, options: ArrayDiffOptions<T> = {}): Edit[] {
  if (!isSequence(oldItems) || !isSequence(newItems)) {
    throw new TypeError(`hunks: diffArrays compares two arrays, got ${describe(isSequence(oldItems) ? newItems : oldItems)}`);
  }
  checkOptions(options);
  if (options.key !== undefined && typeof options.key !== 'function') throw new TypeError('hunks: key must be a function');
  const limit = deadline(options.timeout);
  const key = options.key ?? ((x: T) => x);
  const table = new Map<unknown, number>();
  const intern = (x: T): number => {
    const k = key(x);
    let id = table.get(k);
    if (id === undefined) table.set(k, (id = table.size));
    return id;
  };
  const side = (items: ArrayLike<T>): Side => {
    const ids = Int32Array.from(items, intern);
    return { text: '', starts: new Int32Array(ids.length + 1), n: ids.length, ids };
  };
  const a = side(oldItems as ArrayLike<T>);
  const b = side(newItems as ArrayLike<T>);
  const algorithm = options.algorithm ?? 'myers';
  if (!ALGORITHMS.includes(algorithm)) throw new TypeError(`hunks: unknown algorithm '${algorithm}'`);
  const [ca, cb] = diffSides(a, b, table.size, algorithm, { indentHeuristic: false, anchors: [], git: compat.git, deadline: limit });
  return buildScript(a, b, ca, cb).map((c) => ({ oldStart: c.i1, oldEnd: c.i1 + c.chg1, newStart: c.i2, newEnd: c.i2 + c.chg2 }));
}

export interface InlineOptions {
  /** As for `diff`: give up after this many milliseconds. */
  timeout?: number;
}

/**
 * Word-level highlights for a block of removed lines and the block of added
 * lines that replaced it: for each line, the [start, end) ranges that
 * changed. This is what `diff(..., { inline: true })` attaches as `spans`.
 */
export function inline(
  removed: readonly string[],
  added: readonly string[],
  options: InlineOptions = {},
): { removed: Span[][]; added: Span[][] } {
  for (const [lines, which] of [[removed, 'removed'], [added, 'added']] as const) {
    if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) {
      throw new TypeError(`hunks: inline expects ${which} to be an array of strings`);
    }
  }
  checkOptions(options);
  return inlineSpans(removed, added, deadline(options.timeout));
}
