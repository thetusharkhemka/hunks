/**
 * Render the CLI's colour output for media/demo as an SVG for the README.
 *
 *   node scripts/screenshot.ts > media/demo.svg
 *
 * Every text run gets an explicit textLength, so highlight boxes stay
 * aligned with the text whatever monospace font the viewer has.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const command = ['--color=always', 'old.ts', 'new.ts'];
const result = spawnSync(process.execPath, [join(root, 'src/cli.ts'), ...command], { cwd: join(root, 'media/demo'), encoding: 'utf8' });
const lines = result.stdout.replace(/\n$/, '').split('\n');

const theme = {
  background: '#0d1117',
  border: '#30363d',
  fg: '#e6edf3',
  dim: '#7d8590',
  prompt: '#7d8590',
  red: '#ff7b72',
  green: '#7ee787',
  cyan: '#79c0ff',
  redEmphasis: 'rgba(248, 81, 73, 0.32)',
  greenEmphasis: 'rgba(46, 160, 67, 0.32)',
  whitespace: 'rgba(248, 81, 73, 0.55)',
};

const FONT_SIZE = 13;
const CW = 7.8; // advance per character
const LH = 19; // line height
const PAD_X = 20;
const PAD_Y = 18;

interface Run {
  text: string;
  color: string;
  bold: boolean;
  background: string | null;
}

/** Split one line of SGR-coloured text into styled runs. */
function runs(line: string): Run[] {
  const out: Run[] = [];
  let color = theme.fg;
  let bold = false;
  let reverse = false;
  let bg: string | null = null;
  const re = /\x1b\[([\d;]*)m/g;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    let background = bg;
    if (reverse) background = color === theme.red ? theme.redEmphasis : theme.greenEmphasis;
    out.push({ text, color, bold, background });
  };
  for (let m = re.exec(line); m; m = re.exec(line)) {
    push(line.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (const c of codes) {
      if (c === 0) [color, bold, reverse, bg] = [theme.fg, false, false, null];
      else if (c === 1) bold = true;
      else if (c === 2) color = theme.dim;
      else if (c === 7) reverse = true;
      else if (c === 27) reverse = false;
      else if (c === 31) color = theme.red;
      else if (c === 32) color = theme.green;
      else if (c === 36) color = theme.cyan;
      else if (c === 41) bg = theme.whitespace;
    }
  }
  push(line.slice(last));
  return out;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const prompt: Run[] = [
  { text: '$ ', color: theme.prompt, bold: false, background: null },
  { text: `hunks ${command.slice(1).join(' ')}`, color: theme.fg, bold: false, background: null },
];
const rows: Run[][] = [prompt, [], ...lines.map(runs)];
const columns = Math.max(...rows.map((r) => r.reduce((n, x) => n + x.text.length, 0)));
const width = Math.ceil(PAD_X * 2 + columns * CW);
const height = PAD_Y * 2 + rows.length * LH - 4;

const parts: string[] = [];
rows.forEach((row, i) => {
  const y = PAD_Y + i * LH;
  let col = 0;
  for (const r of row) {
    const x = PAD_X + col * CW;
    const w = r.text.length * CW;
    if (r.background) parts.push(`<rect x="${x.toFixed(1)}" y="${y - 1}" width="${w.toFixed(1)}" height="${LH - 1}" rx="2" fill="${r.background}"/>`);
    if (r.text.trim()) {
      const weight = r.bold ? ' font-weight="600"' : '';
      parts.push(`<text x="${x.toFixed(1)}" y="${y + 13}" textLength="${w.toFixed(1)}" lengthAdjust="spacingAndGlyphs" fill="${r.color}"${weight} xml:space="preserve">${escape(r.text)}</text>`);
    }
    col += r.text.length;
  }
});

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="hunks comparing two versions of a TypeScript file">
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="${theme.background}" stroke="${theme.border}"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT_SIZE}">
${parts.join('\n')}
</g>
</svg>
`);
