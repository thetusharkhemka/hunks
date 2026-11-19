/**
 * Splitting input into records and sorting records into equivalence classes.
 *
 * A record is one line *including* its terminating "\n", exactly as git sees
 * it. The final record may lack the newline. Records are never empty.
 *
 * The engine never looks at characters directly once classification is done:
 * the algorithms compare class ids. Whitespace options are therefore entirely
 * a matter of how a record is reduced to its class key.
 */

/** Whitespace options, mirroring git's XDF_* flags. */
export interface WhitespaceFlags {
  ignoreWhitespace: boolean;
  ignoreWhitespaceChange: boolean;
  ignoreWhitespaceAtEol: boolean;
  ignoreCrAtEol: boolean;
}

/** One side of a comparison. */
export interface Side {
  /**
   * The text. In text mode each char is a UTF-16 code unit; in byte mode each
   * char holds one byte (0-255). Everything outside of header truncation is
   * oblivious to the difference.
   */
  readonly text: string;
  /** starts[i] is the offset of record i; starts[n] === text.length. */
  readonly starts: Int32Array;
  /** Number of records. */
  readonly n: number;
  /** Equivalence class of each record. */
  readonly ids: Int32Array;
}

export function record(side: Side, i: number): string {
  return side.text.slice(side.starts[i], side.starts[i + 1]);
}

/** Record i without its trailing newline. */
export function recordContent(side: Side, i: number): string {
  const s = side.starts[i];
  let e = side.starts[i + 1];
  if (e > s && side.text.charCodeAt(e - 1) === 10) e--;
  return side.text.slice(s, e);
}

export function lineStarts(text: string): Int32Array {
  let count = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++;
  const n = count + (text.length > 0 && text.charCodeAt(text.length - 1) !== 10 ? 1 : 0);
  const starts = new Int32Array(n + 1);
  let r = 0;
  let pos = 0;
  while (r < n) {
    starts[r++] = pos;
    const nl = text.indexOf('\n', pos);
    pos = nl === -1 ? text.length : nl + 1;
  }
  starts[n] = text.length;
  return starts;
}

// git's isspace() is locale-independent and only knows these four.
export function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function hasWhitespaceFlags(f: WhitespaceFlags): boolean {
  return f.ignoreWhitespace || f.ignoreWhitespaceChange || f.ignoreWhitespaceAtEol || f.ignoreCrAtEol;
}

/**
 * Build the function that reduces a record to its class key.
 *
 * git decides equality with a hash *and* a byte comparison; the comparison
 * alone is not even transitive under --ignore-cr-at-eol. The hash is what
 * makes the classes consistent, so the keys below reproduce what the hash
 * function consumes, flag for flag and in the same order of precedence.
 */
export function classKey(flags: WhitespaceFlags): (text: string, start: number, end: number) => string {
  if (!hasWhitespaceFlags(flags)) {
    // Exact: the newline is part of the record, so "x" and "x\n" differ.
    return (text, start, end) => text.slice(start, end);
  }
  if (flags.ignoreWhitespace) {
    return (text, start, end) => {
      let out = '';
      let run = start;
      for (let i = start; i < end; i++) {
        if (isSpace(text.charCodeAt(i))) {
          if (i > run) out += text.slice(run, i);
          run = i + 1;
        }
      }
      return run < end ? out + text.slice(run, end) : out;
    };
  }
  if (flags.ignoreWhitespaceChange || flags.ignoreWhitespaceAtEol) {
    const collapse = flags.ignoreWhitespaceChange;
    return (text, start, end) => {
      if (end > start && text.charCodeAt(end - 1) === 10) end--;
      // A trailing run of whitespace is dropped entirely.
      while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
      if (!collapse) return text.slice(start, end);
      let out = '';
      let i = start;
      let run = start;
      while (i < end) {
        if (isSpace(text.charCodeAt(i))) {
          out += text.slice(run, i) + ' ';
          while (i < end && isSpace(text.charCodeAt(i))) i++;
          run = i;
        } else {
          i++;
        }
      }
      return out + text.slice(run, end);
    };
  }
  // --ignore-cr-at-eol alone: drop the newline, and a CR directly before it.
  return (text, start, end) => {
    if (end > start && text.charCodeAt(end - 1) === 10) {
      end--;
      if (end > start && text.charCodeAt(end - 1) === 13) end--;
    }
    return text.slice(start, end);
  };
}

export interface Classified {
  a: Side;
  b: Side;
  /** Number of distinct classes. */
  classes: number;
}

/** Split both texts into records and assign shared class ids. */
export function classify(textA: string, textB: string, flags: WhitespaceFlags): Classified {
  const key = classKey(flags);
  const table = new Map<string, number>();
  const sides: Side[] = [];
  for (const text of [textA, textB]) {
    const starts = lineStarts(text);
    const n = starts.length - 1;
    const ids = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const k = key(text, starts[i], starts[i + 1]);
      let id = table.get(k);
      if (id === undefined) {
        id = table.size;
        table.set(k, id);
      }
      ids[i] = id;
    }
    sides.push({ text, starts, n, ids });
  }
  return { a: sides[0], b: sides[1], classes: table.size };
}

/**
 * Whether a record counts as blank for --ignore-blank-lines.
 *
 * Without whitespace flags git only checks `size <= 1`, which also matches a
 * final one-byte line with no newline. We keep that quirk; in text mode the
 * size is the UTF-8 length.
 */
export function isBlankRecord(side: Side, i: number, flags: WhitespaceFlags, bytes: boolean): boolean {
  const s = side.starts[i];
  const e = side.starts[i + 1];
  if (!hasWhitespaceFlags(flags)) {
    if (e - s === 0) return true;
    if (e - s > 1) return false;
    return bytes || side.text.charCodeAt(s) < 0x80;
  }
  for (let k = s; k < e; k++) if (!isSpace(side.text.charCodeAt(k))) return false;
  return true;
}

/** A record made entirely of whitespace (used by function-context expansion). */
export function isEmptyRecord(side: Side, i: number): boolean {
  for (let k = side.starts[i]; k < side.starts[i + 1]; k++) {
    if (!isSpace(side.text.charCodeAt(k))) return false;
  }
  return true;
}
