/**
 * Compare against git on a corpus of real file pairs.
 *
 *   node scripts/corpus.ts <corpus-dir> [--algorithm=histogram] [-U0] [--limit=N]
 *
 * The corpus directory holds pairs of package versions, as extracted npm
 * tarballs: <name>@<v1>/package and <name>@<v2>/package, listed in pairs.txt.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compare } from '../test/git.ts';
import type { PatchOptions } from '../src/index.ts';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('-'));
if (!root) {
  console.error('usage: node scripts/corpus.ts <corpus-dir> [options]');
  process.exit(2);
}
const opt = (name: string) => args.find((a) => a.startsWith(name))?.split('=')[1];
const options: PatchOptions = {};
if (opt('--algorithm')) options.algorithm = opt('--algorithm') as PatchOptions['algorithm'];
const u = args.find((a) => /^-U\d+$/.test(a));
if (u) options.context = Number(u.slice(2));
if (args.includes('-w')) options.ignoreWhitespace = true;
if (args.includes('-b')) options.ignoreWhitespaceChange = true;
if (args.includes('-W')) options.functionContext = true;
if (args.includes('--no-indent-heuristic')) options.indentHeuristic = false;
const limit = Number(opt('--limit') ?? Infinity);

function walk(dir: string): string[] {
  const out: string[] = [];
  (function rec(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) rec(p);
      else out.push(relative(dir, p));
    }
  })(dir);
  return out;
}

const pairs = readFileSync(join(root, 'pairs.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
let files = 0;
let failures = 0;
const started = performance.now();
for (const [name, va, vb] of pairs) {
  const A = join(root, `${name.replace('/', '+')}@${va}`, 'package');
  const B = join(root, `${name.replace('/', '+')}@${vb}`, 'package');
  if (!existsSync(A) || !existsSync(B)) continue;
  const inB = new Set(walk(B));
  for (const rel of walk(A)) {
    if (!inB.has(rel) || files >= limit) continue;
    const a = readFileSync(join(A, rel));
    const b = readFileSync(join(B, rel));
    if (a.equals(b)) continue;
    files++;
    const m = compare(a, b, options);
    if (m) {
      failures++;
      if (failures <= 3) {
        console.log(`\nMISMATCH ${name} ${va}->${vb} ${rel}  [${m.flags.join(' ')}]`);
        const e = m.expected.split('\n');
        const x = m.actual.split('\n');
        let k = 0;
        while (k < e.length && e[k] === x[k]) k++;
        console.log(`  first difference at output line ${k + 1}`);
        console.log('  git:   ' + JSON.stringify(e.slice(Math.max(0, k - 2), k + 4)));
        console.log('  hunks: ' + JSON.stringify(x.slice(Math.max(0, k - 2), k + 4)));
      }
    }
  }
}
const secs = ((performance.now() - started) / 1000).toFixed(1);
console.log(`\n${files - failures}/${files} files identical to git (${failures} mismatches) [${JSON.stringify(options)}] in ${secs}s`);
process.exitCode = failures ? 1 : 0;
