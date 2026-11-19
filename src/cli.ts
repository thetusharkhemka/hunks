#!/usr/bin/env node
/**
 * hunks: compare two files the way `git diff --no-index` does.
 *
 * Piped or redirected, the output is byte for byte what git prints, header
 * lines included. On a terminal it is made safe to read: control characters
 * and invisible Unicode in the files are shown as escapes rather than passed
 * to the terminal, and with colour, changed words are highlighted too.
 */

import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, statSync, type Stats } from 'node:fs';
import { fileLine, quotePath } from './core/quote.ts';
import { diff, patch, type Algorithm, type Line, type PatchOptions } from './index.ts';

const HELP = `Usage: hunks [options] <old> <new>

Compare two files the way \`git diff --no-index\` does. Use - for standard
input; pipes such as <(command) work too. Exits with 1 if the files differ,
0 if not, 2 on error. -p, -u, --patch, --exit-code, --no-index and
--no-ext-diff are accepted and change nothing.

On a terminal, control characters and invisible Unicode in the files are
shown as escapes such as ^[ and <U+202E>, so a file can neither drive the
terminal nor hide text. Piped or redirected, the output is exactly git's.

Algorithm
      --diff-algorithm=<a>      myers (default), minimal, patience or histogram
      --histogram, --patience, --minimal
      --anchored=<text>         keep lines starting with <text> unchanged
      --no-indent-heuristic     do not shift hunks to natural boundaries

Output
  -U<n>, --unified[=<n>]        lines of context (default 3)
      --inter-hunk-context=<n>  join hunks up to <n> lines further apart
  -W, --function-context        show whole functions as context
      --color[=<when>]          always, never or auto (default: on for a
                                terminal, off if NO_COLOR is set)
      --no-color                same as --color=never
      --no-inline               do not highlight changed words
  -a, --text                    treat all files as text
      --quiet                   print nothing; only set the exit code

Whitespace
  -w, --ignore-all-space        ignore whitespace when comparing lines
  -b, --ignore-space-change     ignore changes in amount of whitespace
      --ignore-space-at-eol     ignore whitespace at line ends
      --ignore-cr-at-eol        ignore carriage returns at line ends
      --ignore-blank-lines      ignore changes whose lines are all blank
  -I, --ignore-matching-lines=<regex>
                                ignore changes whose lines all match <regex>

  -h, --help                    show this help
  -v, --version                 show the version
`;

class UsageError extends Error {}

interface Cli {
  options: PatchOptions;
  color: 'always' | 'never' | 'auto';
  inline: boolean;
  text: boolean;
  quiet: boolean;
  files: string[];
}

const ALGORITHMS = ['myers', 'minimal', 'patience', 'histogram'];

function parse(argv: string[]): Cli {
  const cli: Cli = { options: {}, color: 'auto', inline: true, text: false, quiet: false, files: [] };
  const o = cli.options;
  const anchors: string[] = [];
  const ignore: RegExp[] = [];

  const integer = (name: string, v: string | undefined): number => {
    if (v === undefined || !/^\d+$/.test(v)) throw new UsageError(`${name} expects a number`);
    return Number(v);
  };
  const algorithm = (v: string): void => {
    // git compares these names without regard to case.
    const name = v.toLowerCase() === 'default' ? 'myers' : v.toLowerCase();
    if (!ALGORITHMS.includes(name)) throw new UsageError(`unknown diff algorithm '${v}'`);
    o.algorithm = name as Algorithm;
  };
  const regex = (v: string): RegExp => {
    try {
      return new RegExp(v);
    } catch {
      throw new UsageError(`invalid regular expression '${v}'`);
    }
  };

  // Short options, alone or bundled as in -wbU5. U takes the rest of the
  // bundle as an optional number and I takes the rest (or the next
  // argument) as a pattern, as with git.
  const short = (arg: string, i: number): number => {
    for (let k = 1; k < arg.length; k++) {
      const c = arg[k];
      const rest = arg.slice(k + 1);
      switch (c) {
        case 'w': o.ignoreWhitespace = true; break;
        case 'b': o.ignoreWhitespaceChange = true; break;
        case 'W': o.functionContext = true; break;
        case 'a': cli.text = true; break;
        case 'p': case 'u': break;
        case 'h': process.stdout.write(HELP); process.exit(0);
        case 'v': process.stdout.write(`${version()}\n`); process.exit(0);
        case 'U':
          if (rest !== '') o.context = integer('-U', rest);
          return i;
        case 'I':
          if (rest !== '') ignore.push(regex(rest));
          else if (i + 1 < argv.length) ignore.push(regex(argv[++i]));
          else throw new UsageError('-I expects a pattern');
          return i;
        default:
          throw new UsageError(`unknown option '-${c}'${arg.length > 2 ? ` in '${arg}'` : ''}`);
      }
    }
    return i;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      cli.files.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      cli.files.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) {
      i = short(arg, i);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const attached = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = (): string => {
      if (attached !== undefined) return attached;
      if (i + 1 >= argv.length) throw new UsageError(`${name} expects a value`);
      return argv[++i];
    };
    const flag = (): void => {
      if (attached !== undefined) throw new UsageError(`${name} takes no value`);
    };

    switch (name) {
      case '--help': process.stdout.write(HELP); process.exit(0);
      case '--version': process.stdout.write(`${version()}\n`); process.exit(0);
      // The value is optional and must be attached, as with git: --unified=5.
      case '--unified': if (attached !== undefined) o.context = integer(name, attached); break;
      case '--inter-hunk-context': o.interHunkContext = integer(name, value()); break;
      case '--function-context': flag(); o.functionContext = true; break;
      case '--diff-algorithm': algorithm(value()); break;
      case '--histogram': flag(); o.algorithm = 'histogram'; break;
      case '--patience': flag(); o.algorithm = 'patience'; break;
      case '--minimal': flag(); o.algorithm = 'minimal'; break;
      case '--anchored': anchors.push(value()); break;
      case '--indent-heuristic': flag(); o.indentHeuristic = true; break;
      case '--no-indent-heuristic': flag(); o.indentHeuristic = false; break;
      case '--ignore-all-space': flag(); o.ignoreWhitespace = true; break;
      case '--ignore-space-change': flag(); o.ignoreWhitespaceChange = true; break;
      case '--ignore-space-at-eol': flag(); o.ignoreWhitespaceAtEol = true; break;
      case '--ignore-cr-at-eol': flag(); o.ignoreCrAtEol = true; break;
      case '--ignore-blank-lines': flag(); o.ignoreBlankLines = true; break;
      case '--ignore-matching-lines': ignore.push(regex(value())); break;
      case '--color': {
        const v = attached ?? 'always';
        if (v !== 'always' && v !== 'never' && v !== 'auto') throw new UsageError('--color expects always, never or auto');
        cli.color = v;
        break;
      }
      case '--no-color': flag(); cli.color = 'never'; break;
      case '--no-inline': flag(); cli.inline = false; break;
      case '--text': flag(); cli.text = true; break;
      case '--quiet': flag(); cli.quiet = true; break;
      case '--patch': case '--exit-code': case '--no-index': case '--no-ext-diff': flag(); break;
      default: throw new UsageError(`unknown option '${arg}'`);
    }
  }
  if (anchors.length) o.anchored = anchors;
  if (ignore.length) o.ignoreMatchingLines = ignore;
  if (cli.files.length !== 2) throw new UsageError('expected two files to compare');
  return cli;
}

function version(): string {
  const pkg = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(pkg, 'utf8')).version;
}

// ---------------------------------------------------------------------------
// Reading the two sides

interface FileSide {
  /** The path as given; - for standard input. */
  path: string;
  /** False for /dev/null: nothing on this side. */
  exists: boolean;
  /** The contents; null for a file too large to load (see LIMIT). */
  data: Uint8Array | null;
  size: number;
  mode: number;
  /** Read from standard input or a pipe, which git does not hash. */
  streamed: boolean;
}

const MODE_LINK = 0o120000;
const EMPTY = new Uint8Array(0);

/**
 * Larger files are shown as binary, as git shows files over 512 MiB
 * (core.bigFileThreshold). This is 24 bytes short of git's threshold: it is
 * the longest string V8 can hold, which bounds what can be diffed as text.
 */
const LIMIT = (1 << 29) - 24;

function absent(path: string): FileSide {
  return { path, exists: false, data: EMPTY, size: 0, mode: 0, streamed: false };
}

function streamed(path: string, data: Uint8Array): FileSide {
  return { path, exists: true, data, size: data.length, mode: 0o100644, streamed: true };
}

function load(path: string): FileSide {
  if (path === '/dev/null' || (process.platform === 'win32' && path.toLowerCase() === 'nul')) return absent(path);
  if (path === '-') return streamed(path, readAll(0, 'standard input'));
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error(`could not access '${path}'`);
  }
  if (st.isSymbolicLink()) {
    // On Linux, <(command) is a link to a pipe. Like git (2.42 and later),
    // read through a link that leads to a pipe; compare any other link by
    // its target, not by what it points to.
    if (isPipe(path)) return readPipe(path);
    const target = new Uint8Array(readlinkSync(path, { encoding: 'buffer' }));
    return { path, exists: true, data: target, size: target.length, mode: MODE_LINK, streamed: false };
  }
  if (st.isFIFO()) return readPipe(path);
  if (st.isDirectory()) throw new UsageError(`'${path}' is a directory; hunks compares two files`);
  if (!st.isFile()) throw new Error(`'${path}' is a ${kind(st)}; hunks compares files, symbolic links and pipes`);
  const mode = st.mode & 0o100 ? 0o100755 : 0o100644;
  if (st.size > LIMIT) return { path, exists: true, data: null, size: st.size, mode, streamed: false };
  let data: Uint8Array;
  try {
    data = new Uint8Array(readFileSync(path));
  } catch (err) {
    throw new Error(`could not read '${path}' (${reason(err)})`);
  }
  return { path, exists: true, data, size: data.length, mode, streamed: false };
}

function isPipe(path: string): boolean {
  try {
    return statSync(path).isFIFO();
  } catch {
    return false;
  }
}

function kind(st: Stats): string {
  if (st.isCharacterDevice()) return 'character device';
  if (st.isBlockDevice()) return 'block device';
  if (st.isSocket()) return 'socket';
  return 'special file';
}

function reason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ENOENT') return 'no such file';
  return err instanceof Error ? err.message : String(err);
}

function readPipe(path: string): FileSide {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    throw new Error(`could not read '${path}' (${reason(err)})`);
  }
  try {
    return streamed(path, readAll(fd, `'${path}'`));
  } finally {
    closeSync(fd);
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4));

/** Read a stream to its end, refusing to hold more than LIMIT bytes. */
function readAll(fd: number, what: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = new Uint8Array(1 << 16);
    let n: number;
    try {
      n = readSync(fd, chunk, 0, chunk.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A non-blocking descriptor with nothing to read yet: wait a little.
      if (code === 'EAGAIN') {
        Atomics.wait(pause, 0, 0, 2);
        continue;
      }
      // Windows reports the end of a pipe as an error.
      if (code === 'EOF') break;
      throw new Error(`could not read ${what} (${reason(err)})`);
    }
    if (n === 0) break;
    total += n;
    if (total > LIMIT) throw new Error(`${what} is larger than 512 MiB`);
    chunks.push(n === chunk.length ? chunk : chunk.subarray(0, n));
  }
  const data = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    data.set(c, at);
    at += c.length;
  }
  return data;
}

/** Fill `buf` from `fd`, short only at the end of the file. */
function fill(fd: number, buf: Uint8Array): number {
  let n = 0;
  while (n < buf.length) {
    const got = readSync(fd, buf, n, buf.length - n, null);
    if (got === 0) break;
    n += got;
  }
  return n;
}

/** Whether two files too large to load have the same contents. */
function sameOnDisk(pathA: string, pathB: string): boolean {
  const fa = openSync(pathA, 'r');
  try {
    const fb = openSync(pathB, 'r');
    try {
      const ba = Buffer.allocUnsafe(1 << 20);
      const bb = Buffer.allocUnsafe(1 << 20);
      for (;;) {
        const na = fill(fa, ba);
        const nb = fill(fb, bb);
        if (na !== nb || ba.compare(bb, 0, nb, 0, na) !== 0) return false;
        if (na === 0) return true;
      }
    } finally {
      closeSync(fb);
    }
  } finally {
    closeSync(fa);
  }
}

function sameContent(a: FileSide, b: FileSide): boolean {
  if (a.size !== b.size) return false;
  if (a.data !== null && b.data !== null) return Buffer.compare(a.data, b.data) === 0;
  return sameOnDisk(a.path, b.path);
}

/** As git decides: a NUL byte in the first 8000 bytes, or a file over the limit. */
function isBinary(side: FileSide): boolean {
  return side.data === null || side.data.subarray(0, 8000).includes(0);
}

const ZERO_ID = '0'.repeat(40);

/** The git blob id, or zeros where git has none: nothing, stdin or a pipe. */
function blobId(side: FileSide): string {
  if (!side.exists || side.streamed) return ZERO_ID;
  const h = createHash('sha1');
  h.update(`blob ${side.size}\0`);
  if (side.data !== null) {
    h.update(side.data);
  } else {
    const fd = openSync(side.path, 'r');
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (let n = fill(fd, buf); n > 0; n = fill(fd, buf)) h.update(buf.subarray(0, n));
    } finally {
      closeSync(fd);
    }
  }
  return h.digest('hex');
}

const octal = (mode: number) => mode.toString(8).padStart(6, '0');

/** The header block git prints before the hunks. */
function headerLines(a: FileSide, b: FileSide): { lines: string[]; labels: [string, string] } {
  const nameA = a.exists ? a.path : b.path;
  const nameB = b.exists ? b.path : a.path;
  const strip = (p: string) => (p.startsWith('/') ? p.slice(1) : p);
  const aOne = quotePath('a/' + strip(nameA));
  const bTwo = quotePath('b/' + strip(nameB));
  const labels: [string, string] = [a.exists ? aOne : '/dev/null', b.exists ? bTwo : '/dev/null'];
  const lines = [`diff --git ${aOne} ${bTwo}`];
  if (!a.exists) lines.push(`new file mode ${octal(b.mode)}`);
  else if (!b.exists) lines.push(`deleted file mode ${octal(a.mode)}`);
  else if (a.mode !== b.mode) lines.push(`old mode ${octal(a.mode)}`, `new mode ${octal(b.mode)}`);
  // git prints the blob ids when they differ, so not for two pipes, nor for
  // standard input against /dev/null: all of those count as zeros.
  const idA = blobId(a);
  const idB = blobId(b);
  if (idA !== idB) {
    let index = `index ${idA.slice(0, 7)}..${idB.slice(0, 7)}`;
    if (a.mode === b.mode) index += ` ${octal(a.mode)}`;
    lines.push(index);
  }
  return { lines, labels };
}

// ---------------------------------------------------------------------------
// Showing text on a terminal

const SGR = {
  reset: '\x1b[m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  emphasis: '\x1b[7m',
  noEmphasis: '\x1b[27m',
  escape: '\x1b[4m',
  noEscape: '\x1b[24m',
  whitespace: '\x1b[41m',
  noBackground: '\x1b[49m',
};

const PLAIN_ASCII = /^[\t\x20-\x7e]*$/;
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

const SHOWN = 1;
const SELECTOR = 2;
const JOINER = 3;

/**
 * Makes text safe to show on a terminal. Control characters become caret
 * escapes (^[ for ESC), as `cat -v` and `less` show them, so that a file
 * cannot move the cursor, set the clipboard or retitle the window. Code
 * points that are invisible or reorder the text around them become
 * <U+202E>: the bidirectional overrides of "Trojan Source" attacks, zero
 * width characters, Unicode tags that smuggle hidden text, a byte order
 * mark. Joiners and variation selectors stay when they follow something
 * visible, as they do inside emoji; a run of them is shown, since that is
 * how text gets hidden in them.
 */
class Printer {
  private readonly mark: (escape: string) => string;
  private prev = 0;

  constructor(paint: boolean) {
    this.mark = paint ? (e) => SGR.escape + e + SGR.noEscape : (e) => e;
  }

  print(text: string): string {
    if (PLAIN_ASCII.test(text)) {
      if (text.length > 0) this.prev = SHOWN;
      return text;
    }
    let out = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      let state = SHOWN;
      if (cp < 0x20 || cp === 0x7f) {
        if (cp !== 9) {
          out += this.mark(cp === 0x7f ? '^?' : '^' + String.fromCharCode(cp + 64));
          this.prev = 0;
          continue;
        }
      } else if (cp >= 0x80) {
        if (cp <= 0x9f || cp === 0x2028 || cp === 0x2029) state = 0;
        else if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) state = this.prev === SHOWN ? SELECTOR : 0;
        else if (cp === 0x200c || cp === 0x200d) state = this.prev === SHOWN || this.prev === SELECTOR ? JOINER : 0;
        else if (IGNORABLE.test(ch)) state = 0;
      }
      out += state === 0 ? this.mark(`<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`) : ch;
      this.prev = state;
    }
    return out;
  }
}

/** Text from outside, such as a file name in an error message, made safe. */
const printable = (text: string) => new Printer(false).print(text);

const CHANGED = 1;
const WHITESPACE_ERROR = 2;

/** git's isspace: space, tab, CR and LF only. */
const isGitSpace = (c: number) => c === 32 || c === 9 || c === 13 || c === 10;

/**
 * Mark what git's default core.whitespace flags on an added line: trailing
 * whitespace, and spaces that come before a tab in the indentation.
 * Both scans are linear.
 */
function markWhitespaceErrors(text: string, end: number, style: Uint8Array): void {
  let trail = end;
  while (trail > 0 && isGitSpace(text.charCodeAt(trail - 1))) trail--;
  let written = 0;
  for (let i = 0; i < trail; i++) {
    const c = text.charCodeAt(i);
    if (c === 32) continue;
    if (c !== 9) break;
    if (written < i) style.fill(WHITESPACE_ERROR, written, i);
    written = i + 1;
  }
  style.fill(WHITESPACE_ERROR, trail, end);
}

function renderLine(line: Line, paint: boolean, inline: boolean): string {
  const text = line.text;
  // A carriage return before the line break belongs to the line ending, as
  // in files with Windows line endings: it is not shown, unless it is
  // itself what changed.
  let end = text.length;
  const cr = end > 0 && text.charCodeAt(end - 1) === 13;
  if (cr) end--;

  const style = new Uint8Array(end);
  let crChanged = false;
  if (paint && inline && line.spans) {
    for (const [s, e] of line.spans) {
      if (s < end) style.fill(CHANGED, s, Math.min(e, end));
      if (cr && e > end) crChanged = true;
    }
  }
  if (paint && line.type === 'added') markWhitespaceErrors(text, end, style);

  const printer = new Printer(paint);
  const color = !paint ? '' : line.type === 'removed' ? SGR.red : line.type === 'added' ? SGR.green : '';
  let out = color + (line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' ');
  for (let i = 0; i < end;) {
    const s = style[i];
    let j = i + 1;
    while (j < end && style[j] === s) j++;
    const piece = printer.print(text.slice(i, j));
    if (s === CHANGED) out += SGR.emphasis + piece + SGR.noEmphasis;
    else if (s === WHITESPACE_ERROR) out += SGR.whitespace + piece + SGR.noBackground;
    else out += piece;
    i = j;
  }
  if (crChanged) out += SGR.emphasis + printer.print('\r') + SGR.noEmphasis;
  out += color ? SGR.reset + '\n' : '\n';
  if (!line.newline) out += paint ? `${SGR.dim}\\ No newline at end of file${SGR.reset}\n` : '\\ No newline at end of file\n';
  return out;
}

function renderHunks(a: Uint8Array, b: Uint8Array, cli: Cli, paint: boolean): string[] {
  const out: string[] = [];
  const d = diff(a, b, { ...cli.options, inline: paint && cli.inline });
  for (const h of d.hunks) {
    // The heading comes from the file, so it is escaped like any line.
    const at = h.header.indexOf(' @@') + 3;
    const range = h.header.slice(0, at);
    const heading = new Printer(paint).print(h.header.slice(at));
    out.push(paint ? `${SGR.cyan}${range}${SGR.reset}${heading}\n` : `${range}${heading}\n`);
    for (const line of h.lines) out.push(renderLine(line, paint, cli.inline));
  }
  return out;
}

interface View {
  /** Colour and highlight. */
  paint: boolean;
  /** Escape what a terminal would act on; when false, print git's bytes. */
  safe: boolean;
}

/**
 * One `diff --git` section: header lines and hunks, or nothing at all when
 * there is nothing to show (as for whitespace-only changes under -w).
 */
function section(a: FileSide, b: FileSide, cli: Cli, view: View): (string | Uint8Array)[] {
  const differs = !a.exists || !b.exists || !sameContent(a, b);
  const binary = differs && !cli.text && (isBinary(a) || isBinary(b));

  // Like git, the header is only printed when there is something to show:
  // hunks, a binary difference, or a change of mode or existence.
  let hunks: (string | Uint8Array)[] = [];
  if (differs && !binary) {
    for (const side of [a, b]) {
      if (side.data === null) throw new Error(`'${side.path}' is over 512 MiB, too large to compare as text`);
    }
    if (view.safe) {
      hunks = renderHunks(a.data!, b.data!, cli, view.paint);
    } else {
      const p = patch(a.data!, b.data!, cli.options);
      if (p.length > 0) hunks = [p];
    }
  }
  const mustShowHeader = !a.exists || !b.exists || a.mode !== b.mode;
  if (hunks.length === 0 && !binary && !mustShowHeader) return [];

  const { lines, labels } = headerLines(a, b);
  const meta = (s: string) => (view.paint ? `${SGR.bold}${s}${SGR.reset}\n` : `${s}\n`);
  const out: (string | Uint8Array)[] = lines.map(meta);
  if (binary) {
    out.push(`Binary files ${labels[0]} and ${labels[1]} differ\n`);
  } else if (hunks.length > 0) {
    out.push(meta(fileLine('---', labels[0])), meta(fileLine('+++', labels[1])), ...hunks);
  }
  return out;
}

/** Colour by default only on a terminal that shows it, as Node judges: NO_COLOR and TERM=dumb turn it off. */
function colorTerminal(): boolean {
  const out = process.stdout;
  if (!out.isTTY) return false;
  if (typeof out.hasColors === 'function') return out.hasColors();
  return !process.env.NO_COLOR && process.env.TERM !== 'dumb';
}

function main(argv: string[]): number {
  const cli = parse(argv);
  const a = load(cli.files[0]);
  // git compares standard input with itself as the same.
  const b = cli.files[0] === '-' && cli.files[1] === '-' ? a : load(cli.files[1]);
  if (!a.exists && !b.exists) return 0;
  const paint = !cli.quiet && (cli.color === 'always' || (cli.color === 'auto' && colorTerminal()));
  const view: View = { paint, safe: !cli.quiet && (paint || !!process.stdout.isTTY) };

  // A file that turns into a symbolic link, or back, is shown by git as a
  // deletion followed by a creation.
  const typeChange = a.exists && b.exists && (a.mode === MODE_LINK) !== (b.mode === MODE_LINK);
  const out = typeChange
    ? [...section(a, absent(b.path), cli, view), ...section(absent(a.path), b, cli, view)]
    : section(a, b, cli, view);

  if (out.length === 0) return 0;
  if (!cli.quiet) {
    process.stdout.on('error', (err: NodeJS.ErrnoException) => {
      // When the reader goes away, as `| head` does, stop quietly, with
      // the status of a process killed by SIGPIPE, which is what git does.
      if (err.code === 'EPIPE') process.exit(141);
      process.stderr.write(`hunks: ${printable(err.message)}\n`);
      process.exit(2);
    });
    process.stdout.write(Buffer.concat(out.map((c) => (typeof c === 'string' ? Buffer.from(c) : c))));
  }
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  let message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('hunks: ')) message = message.slice('hunks: '.length);
  process.stderr.write(`hunks: ${printable(message)}\n`);
  if (err instanceof UsageError) process.stderr.write(`Try 'hunks --help' for more information.\n`);
  process.exitCode = 2;
}
