#!/usr/bin/env node
/**
 * hunks: compare two files the way `git diff --no-index` does.
 *
 * Without colour the output is byte for byte what git prints, header lines
 * included. With colour, changed words inside lines are highlighted too.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { diff, patch, type Algorithm, type Line, type PatchOptions } from './index.ts';

const HELP = `Usage: hunks [options] <old> <new>

Compare two files the way \`git diff --no-index\` does. Use - to read stdin.
Exits with 1 if the files differ, 0 if not, 2 on error. -p, -u, --patch,
--exit-code, --no-index and --no-ext-diff are accepted and change nothing.

Algorithm
      --diff-algorithm=<a>      myers (default), minimal, patience or histogram
      --histogram, --patience, --minimal
      --anchored=<text>         keep lines starting with <text> unchanged
      --no-indent-heuristic     do not shift hunks to natural boundaries

Output
  -U<n>, --unified[=<n>]        lines of context (default 3)
      --inter-hunk-context=<n>  join hunks up to <n> lines further apart
  -W, --function-context        show whole functions as context
      --color[=<when>]          always, never or auto (default auto)
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

interface FileSide {
  path: string;
  /** null for /dev/null. */
  data: Uint8Array | null;
  mode: number;
  /** git does not hash standard input; its blob id shows as zeros. */
  stdin: boolean;
}

const MODE_LINK = 0o120000;

let stdinData: Uint8Array | null = null;

function load(path: string): FileSide {
  if (path === '/dev/null') return { path, data: null, mode: 0, stdin: false };
  if (path === '-') {
    stdinData ??= new Uint8Array(readFileSync(0));
    return { path, data: stdinData, mode: 0o100644, stdin: true };
  }
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error(`could not access '${path}'`);
  }
  if (st.isDirectory()) throw new UsageError(`'${path}' is a directory; hunks compares two files`);
  // Like git, compare a symbolic link by its target, not by what it points to.
  if (st.isSymbolicLink()) return { path, data: new Uint8Array(readlinkSync(path, { encoding: 'buffer' })), mode: MODE_LINK, stdin: false };
  return { path, data: new Uint8Array(readFileSync(path)), mode: st.mode & 0o100 ? 0o100755 : 0o100644, stdin: false };
}

/** git's quote_c_style with core.quotePath on. */
function quote(prefix: string, name: string): string {
  const bytes = new TextEncoder().encode(name);
  const named: Record<number, string> = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 34: '"', 92: '\\' };
  let needs = false;
  let out = '';
  for (const c of bytes) {
    if (c < 0x20 || c === 0x22 || c === 0x5c || c >= 0x7f) {
      needs = true;
      out += named[c] !== undefined ? '\\' + named[c] : '\\' + c.toString(8).padStart(3, '0');
    } else {
      out += String.fromCharCode(c);
    }
  }
  return needs ? `"${prefix}${out}"` : prefix + name;
}

function blobId(side: FileSide): string {
  const data = side.data;
  if (data === null || side.stdin) return '0'.repeat(7);
  const h = createHash('sha1');
  h.update(`blob ${data.length}\0`);
  h.update(data);
  return h.digest('hex').slice(0, 7);
}

function isBinary(data: Uint8Array | null): boolean {
  return data !== null && data.subarray(0, 8000).includes(0);
}

const octal = (mode: number) => mode.toString(8).padStart(6, '0');

/** The header block git prints before the hunks. */
function headerLines(a: FileSide, b: FileSide): { lines: string[]; labels: [string, string] } {
  const nameA = a.data === null ? b.path : a.path;
  const nameB = b.data === null ? a.path : b.path;
  const strip = (p: string) => (p.startsWith('/') ? p.slice(1) : p);
  const aOne = quote('a/', strip(nameA));
  const bTwo = quote('b/', strip(nameB));
  const labels: [string, string] = [a.data === null ? '/dev/null' : aOne, b.data === null ? '/dev/null' : bTwo];
  const lines = [`diff --git ${aOne} ${bTwo}`];
  if (a.data === null) lines.push(`new file mode ${octal(b.mode)}`);
  else if (b.data === null) lines.push(`deleted file mode ${octal(a.mode)}`);
  else if (a.mode !== b.mode) lines.push(`old mode ${octal(a.mode)}`, `new mode ${octal(b.mode)}`);
  const same = a.data !== null && b.data !== null && Buffer.from(a.data).equals(Buffer.from(b.data));
  if (!same) {
    let index = `index ${blobId(a)}..${blobId(b)}`;
    if (a.mode === b.mode) index += ` ${octal(a.mode)}`;
    lines.push(index);
  }
  return { lines, labels };
}

const label = (prefix: string, name: string) => `${prefix} ${name}${name.includes(' ') ? '\t' : ''}`;

const SGR = {
  reset: '\x1b[m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  emphasis: '\x1b[7m',
  noEmphasis: '\x1b[27m',
  whitespace: '\x1b[41m',
};

function paintLine(line: Line, inline: boolean): string {
  const color = line.type === 'removed' ? SGR.red : line.type === 'added' ? SGR.green : '';
  const sign = line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' ';
  let text = line.text;
  let tail = '';
  // Like git, flag trailing whitespace on added lines.
  if (line.type === 'added') {
    const m = /[ \t]+\r?$/.exec(text);
    if (m) {
      tail = SGR.whitespace + text.slice(m.index) + SGR.reset;
      text = text.slice(0, m.index);
    }
  }
  let body = text;
  if (inline && line.spans && line.spans.length > 0) {
    body = '';
    let pos = 0;
    for (const [s, e] of line.spans) {
      const start = Math.min(s, text.length);
      const end = Math.min(e, text.length);
      body += text.slice(pos, start) + SGR.emphasis + text.slice(start, end) + SGR.noEmphasis;
      pos = end;
    }
    body += text.slice(pos);
  }
  let out = color ? `${color}${sign}${body}${SGR.reset}${tail}\n` : `${sign}${body}${tail}\n`;
  if (!line.newline) out += `${SGR.dim}\\ No newline at end of file${SGR.reset}\n`;
  return out;
}

/**
 * One `diff --git` section: header lines and hunks, or nothing at all when
 * there is nothing to show (as for whitespace-only changes under -w).
 */
function section(a: FileSide, b: FileSide, cli: Cli, useColor: boolean): (string | Uint8Array)[] {
  const dataA = a.data ?? new Uint8Array(0);
  const dataB = b.data ?? new Uint8Array(0);
  const contentDiffers = a.data === null || b.data === null || !Buffer.from(dataA).equals(Buffer.from(dataB));
  const binary = contentDiffers && !cli.text && (isBinary(a.data) || isBinary(b.data));

  // Like git, the header is only printed when there is something to show:
  // hunks, a binary difference, or a change of mode or existence.
  let hunks: (string | Uint8Array)[] = [];
  if (contentDiffers && !binary) {
    if (useColor) {
      const decoder = new TextDecoder();
      const d = diff(decoder.decode(dataA), decoder.decode(dataB), { ...cli.options, inline: cli.inline });
      for (const h of d.hunks) {
        const at = h.header.indexOf(' @@') + 3;
        hunks.push(`${SGR.cyan}${h.header.slice(0, at)}${SGR.reset}${h.header.slice(at)}\n`);
        for (const line of h.lines) hunks.push(paintLine(line, cli.inline));
      }
    } else {
      const p = patch(dataA, dataB, cli.options);
      if (p.length > 0) hunks = [p];
    }
  }
  const mustShowHeader = a.data === null || b.data === null || a.mode !== b.mode;
  if (hunks.length === 0 && !binary && !mustShowHeader) return [];

  const { lines, labels } = headerLines(a, b);
  const meta = (s: string) => (useColor ? `${SGR.bold}${s}${SGR.reset}\n` : `${s}\n`);
  const out: (string | Uint8Array)[] = lines.map(meta);
  if (binary) {
    out.push(`Binary files ${labels[0]} and ${labels[1]} differ\n`);
  } else if (hunks.length > 0) {
    out.push(meta(label('---', labels[0])), meta(label('+++', labels[1])), ...hunks);
  }
  return out;
}

function main(argv: string[]): number {
  const cli = parse(argv);
  const a = load(cli.files[0]);
  const b = load(cli.files[1]);
  if (a.data === null && b.data === null) return 0;
  const useColor = !cli.quiet && (cli.color === 'always' || (cli.color === 'auto' && !!process.stdout.isTTY && !process.env.NO_COLOR));

  // A file that turns into a symbolic link, or back, is shown by git as a
  // deletion followed by a creation.
  const typeChange = a.data !== null && b.data !== null && (a.mode === MODE_LINK) !== (b.mode === MODE_LINK);
  const none = (path: string): FileSide => ({ path, data: null, mode: 0, stdin: false });
  const out = typeChange
    ? [...section(a, none(b.path), cli, useColor), ...section(none(a.path), b, cli, useColor)]
    : section(a, b, cli, useColor);

  if (out.length === 0) return 0;
  if (!cli.quiet) for (const chunk of out) process.stdout.write(chunk);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`hunks: ${message}\n`);
  if (err instanceof UsageError) process.stderr.write(`Try 'hunks --help' for more information.\n`);
  process.exitCode = 2;
}
