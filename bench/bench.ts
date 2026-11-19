/**
 * Benchmark hunks against other JavaScript diff libraries on real files:
 * consecutive releases of popular npm packages.
 *
 *   cd bench && npm install --ignore-scripts && node bench.ts
 *
 * Fixtures are fetched with `npm pack` into bench/.cache on first run.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, '.cache');

interface Case {
  name: string;
  pkg: string;
  from: string;
  to: string;
  file: string;
}

const CASES: Case[] = [
  { name: 'express response.js, a typical edit', pkg: 'express', from: '4.21.2', to: '5.0.0', file: 'lib/response.js' },
  { name: 'lodash.js, one small fix in 17k lines', pkg: 'lodash', from: '4.17.20', to: '4.17.21', file: 'lodash.js' },
  { name: 'jquery.js, a release apart', pkg: 'jquery', from: '3.6.0', to: '3.7.0', file: 'dist/jquery.js' },
  { name: 'react-dom client build, heavily rewritten', pkg: 'react-dom', from: '19.0.0', to: '19.1.0', file: 'cjs/react-dom-client.development.js' },
  { name: 'three.js WebGPU build, 63k lines', pkg: 'three', from: '0.172.0', to: '0.173.0', file: 'build/three.webgpu.nodes.js' },
];

const LIBRARIES = [
  'hunks',
  'hunks (histogram)',
  'diff (jsdiff)',
  '@jest/diff-sequences',
  'fast-myers-diff',
  'diff-match-patch',
  'vscode-diff',
  '@vscode/diff',
];

const TIME_LIMIT_MS = 60_000;

function fixture(pkg: string, version: string): string {
  const dir = join(cache, `${pkg}@${version}`);
  if (!existsSync(join(dir, 'package'))) {
    mkdirSync(dir, { recursive: true });
    const tgz = execFileSync('npm', ['pack', `${pkg}@${version}`, '--silent'], { cwd: dir, encoding: 'utf8' }).trim();
    execFileSync('tar', ['xzf', tgz], { cwd: dir });
  }
  return join(dir, 'package');
}

const filter = process.argv[2];
const rows: string[] = [];
for (const c of CASES) {
  const a = join(fixture(c.pkg, c.from), c.file);
  const b = join(fixture(c.pkg, c.to), c.file);
  const lines = readFileSync(a, 'utf8').split('\n').length;
  console.log(`\n${c.name} (${lines.toLocaleString('en')} lines)`);
  const cells: string[] = [];
  for (const lib of LIBRARIES) {
    if (filter && !lib.includes(filter)) continue;
    const r = spawnSync(process.execPath, [join(here, 'run-one.ts'), lib, a, b], { encoding: 'utf8', timeout: TIME_LIMIT_MS, cwd: here });
    let cell: string;
    if (r.error || r.signal) cell = `> ${TIME_LIMIT_MS / 1000} s`;
    else if (r.status !== 0) cell = 'fails';
    else {
      const { median } = JSON.parse(r.stdout.trim().split('\n').pop()!);
      cell = median >= 1000 ? `${(median / 1000).toFixed(1)} s` : `${median.toFixed(median < 10 ? 1 : 0)} ms`;
    }
    console.log(`  ${lib.padEnd(24)} ${cell}`);
    cells.push(cell);
  }
  rows.push(`| ${c.name} | ${cells.join(' | ')} |`);
}

console.log(`\n| case | ${LIBRARIES.join(' | ')} |\n|${'---|'.repeat(LIBRARIES.length + 1)}\n${rows.join('\n')}`);
