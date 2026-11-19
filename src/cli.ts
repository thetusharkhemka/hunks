#!/usr/bin/env node
/**
 * hunks: compare two files the way `git diff --no-index` does.
 *
 * Without colour the output is byte for byte what git prints, header lines
 * included. With colour, changed words inside lines are highlighted too.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { diff, patch, type Algorithm, type Line, type PatchOptions } from './index.ts';

const HELP = `Usage: hunks [options] <old> <new>

Compare two files the way \`git diff --no-index\` does. Use - to read stdin.
Exits with 1 if the files differ, 0 if not, 2 on error.

Algorithm
      --diff-algorithm=<a>      myers (default), minimal, patience or histogram
      --histogram, --patience, --minimal
      --anchored=<text>         keep lines starting with <text> unchanged
      --no-indent-heuristic     do not shift hunks to natural boundaries

Output
  -U, --unified=<n>             lines of context (default 3)
      --inter-hunk-context=<n>  join hunks up to <n> lines further apart
  -W, --function-context        show whole functions as context
      --color[=<when>]          always, never or auto (default auto)
      --no-color                same as --color=never
      --no-inline               do not highlight changed words
  -a, --text                    treat all files as text

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
  files: string[];
}

function parse(argv: string[]): Cli {
  const cli: Cli = { options: {}, color: 'auto', inline: true, text: false, files: [] };
  const o = cli.options;
  const anchors: string[] = [];
  const ignore: RegExp[] = [];

  const integer = (name: string, v: string | undefined): number => {
    if (v === undefined || !/^\d+$/.test(v)) throw new UsageError(`${name} expects a number`);
    return Number(v);
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
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    const inlineValue = arg.startsWith('--') && eq !== -1 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      if (i + 1 >= argv.length) throw new UsageError(`${name} expects a value`);
      return argv[++i];
    };

    if (/^-U\d+$/.test(arg)) {
      o.context = Number(arg.slice(2));
      continue;
    }
    if (arg.startsWith('-I') && arg.length > 2 && !arg.startsWith('--')) {
      ignore.push(new RegExp(arg.slice(2)));
      continue;
    }
    switch (name) {
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0);
      case '-v': case '--version': process.stdout.write(`${version()}\n`); process.exit(0);
      case '-U': case '--unified': o.context = integer(name, value()); break;
      case '--inter-hunk-context': o.interHunkContext = integer(name, value()); break;
      case '-W': case '--function-context': o.functionContext = true; break;
      case '--diff-algorithm': {
        const v = value();
        const algorithm = v === 'default' ? 'myers' : v;
        if (!['myers', 'minimal', 'patience', 'histogram'].includes(algorithm)) throw new UsageError(`unknown diff algorithm '${v}'`);
        o.algorithm = algorithm as Algorithm;
        break;
      }
      case '--histogram': o.algorithm = 'histogram'; break;
      case '--patience': o.algorithm = 'patience'; break;
      case '--minimal': o.algorithm = 'minimal'; break;
      case '--anchored': anchors.push(value()); break;
      case '--indent-heuristic': o.indentHeuristic = true; break;
      case '--no-indent-heuristic': o.indentHeuristic = false; break;
      case '-w': case '--ignore-all-space': o.ignoreWhitespace = true; break;
      case '-b': case '--ignore-space-change': o.ignoreWhitespaceChange = true; break;
      case '--ignore-space-at-eol': o.ignoreWhitespaceAtEol = true; break;
      case '--ignore-cr-at-eol': o.ignoreCrAtEol = true; break;
      case '--ignore-blank-lines': o.ignoreBlankLines = true; break;
      case '-I': case '--ignore-matching-lines': ignore.push(new RegExp(value())); break;
      case '--color': {
        const v = inlineValue ?? 'always';
        if (v !== 'always' && v !== 'never' && v !== 'auto') throw new UsageError(`--color expects always, never or auto`);
        cli.color = v;
        break;
      }
      case '--no-color': cli.color = 'never'; break;
      case '--no-inline': cli.inline = false; break;
      case '-a': case '--text': cli.text = true; break;
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
}

function load(path: string): FileSide {
  if (path === '/dev/null') return { path, data: null, mode: 0 };
  if (path === '-') return { path, data: new Uint8Array(readFileSync(0)), mode: 0o100644 };
  const st = statSync(path);
  if (st.isDirectory()) throw new UsageError(`${path} is a directory; hunks compares files`);
  return { path, data: new Uint8Array(readFileSync(path)), mode: st.mode & 0o100 ? 0o100755 : 0o100644 };
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

function blobId(data: Uint8Array | null): string {
  if (data === null) return '0'.repeat(7);
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
    let index = `index ${blobId(a.data)}..${blobId(b.data)}`;
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

function main(argv: string[]): number {
  const cli = parse(argv);
  const a = load(cli.files[0]);
  const b = load(cli.files[1]);
  if (a.data === null && b.data === null) return 0;
  const useColor = cli.color === 'always' || (cli.color === 'auto' && !!process.stdout.isTTY && !process.env.NO_COLOR);

  const dataA = a.data ?? new Uint8Array(0);
  const dataB = b.data ?? new Uint8Array(0);
  const contentDiffers = a.data === null || b.data === null || !Buffer.from(dataA).equals(Buffer.from(dataB));
  const binary = contentDiffers && !cli.text && (isBinary(a.data) || isBinary(b.data));

  // Like git, the header is only printed when there is something to show:
  // hunks, a binary difference, or a change of mode or existence.
  const body: string[] = [];
  let hunks: (string | Uint8Array)[] = [];
  if (contentDiffers && !binary) {
    if (useColor) {
      const decoder = new TextDecoder();
      const d = diff(decoder.decode(dataA), decoder.decode(dataB), { ...cli.options, inline: cli.inline });
      for (const h of d.hunks) {
        const at = h.header.indexOf(' @@') + 3;
        body.push(`${SGR.cyan}${h.header.slice(0, at)}${SGR.reset}${h.header.slice(at)}\n`);
        for (const line of h.lines) body.push(paintLine(line, cli.inline));
      }
      hunks = body;
    } else {
      const p = patch(dataA, dataB, cli.options);
      if (p.length > 0) hunks = [p];
    }
  }
  const mustShowHeader = a.data === null || b.data === null || a.mode !== b.mode;
  if (hunks.length === 0 && !binary && !mustShowHeader) return 0;

  const { lines, labels } = headerLines(a, b);
  const meta = (s: string) => (useColor ? `${SGR.bold}${s}${SGR.reset}\n` : `${s}\n`);
  const out: (string | Uint8Array)[] = lines.map(meta);
  if (binary) {
    out.push(`Binary files ${labels[0]} and ${labels[1]} differ\n`);
  } else if (hunks.length > 0) {
    out.push(meta(label('---', labels[0])), meta(label('+++', labels[1])), ...hunks);
  }
  for (const chunk of out) process.stdout.write(chunk);
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
