/**
 * Download the corpus of real releases that the parity claims rest on.
 *
 *   node scripts/fetch-corpus.ts <dir>
 *
 * scripts/releases.txt lists three consecutive releases of a package per
 * line. Each release is fetched with `npm pack` (no install scripts run)
 * and unpacked into <dir>/<name>@<version>/package. Then <dir>/pairs.txt
 * holds the first two releases of each line, for scripts/corpus.ts and
 * bench/jsdiff-compare.ts, and <dir>/triples.txt all three, for
 * scripts/merge-corpus.ts and bench/merge-compare.ts. Nothing downloaded is
 * run; the files are only read.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/fetch-corpus.ts <dir>');
  process.exit(2);
}
const lines = readFileSync(join(import.meta.dirname, 'releases.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
const tarballs = join(dir, '.tarballs');
mkdirSync(tarballs, { recursive: true });

for (const [name, ...versions] of lines) {
  for (const version of versions) {
    const target = join(dir, `${name.replace('/', '+')}@${version}`);
    if (existsSync(join(target, 'package'))) continue;
    const file = execFileSync('npm', ['pack', `${name}@${version}`, '--ignore-scripts', '--silent', '--pack-destination', tarballs], { encoding: 'utf8' }).trim().split('\n').pop()!;
    mkdirSync(target, { recursive: true });
    execFileSync('tar', ['--no-same-owner', '-xzf', join(tarballs, file), '-C', target]);
    console.log(`${name}@${version}`);
  }
}
writeFileSync(join(dir, 'pairs.txt'), lines.map(([name, a, b]) => `${name} ${a} ${b}`).join('\n') + '\n');
writeFileSync(join(dir, 'triples.txt'), lines.map((l) => l.join(' ')).join('\n') + '\n');
console.log(`\n${lines.length} release triples in ${dir}`);
