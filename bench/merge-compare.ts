/**
 * How other JavaScript merge libraries compare with git on real merges.
 *
 *   cd bench && npm install --ignore-scripts && node merge-compare.ts <corpus-dir>
 *
 * Uses the release triples of scripts/merge-corpus.ts: every text file
 * changed on both sides of a merge. git's result comes from hunks, which
 * scripts/merge-corpus.ts checks against git on the same files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { merge } from '../src/index.ts';

const require = createRequire(import.meta.url);
const nodeDiff3 = require('node-diff3') as { diff3Merge: (a: string[], o: string[], b: string[]) => Block[] };
const diff3 = require('diff3') as (a: string[], o: string[], b: string[]) => Block[];

interface Block {
  ok?: string[];
  conflict?: { a: string[]; o: string[]; b: string[] };
}

const root = process.argv[2];
const triples = readFileSync(join(root, 'triples.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
const dirOf = (pkg: string, v: string) => join(root, `${pkg.replace('/', '+')}@${v}`, 'package');
const walk = (dir: string): string[] => {
  const out: string[] = [];
  (function rec(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) rec(p);
      else out.push(relative(dir, p));
    }
  })(dir);
  return out;
};

/** git's merge style, written from blocks. */
function render(blocks: Block[]): string {
  const lines: string[] = [];
  const add = (xs: string[]) => {
    for (const x of xs) lines.push(x);
  };
  for (const b of blocks) {
    if (b.ok) {
      add(b.ok);
    } else {
      lines.push('<<<<<<<');
      add(b.conflict!.a);
      lines.push('=======');
      add(b.conflict!.b);
      lines.push('>>>>>>>');
    }
  }
  return lines.join('\n');
}

const tally = () => ({ same: 0, cleanButDifferent: 0, falseConflict: 0, missedConflict: 0, bothConflict: 0, bothConflictSame: 0, time: 0 });
const results = { 'node-diff3': tally(), diff3: tally() };
let merges = 0;
let hunksTime = 0;
let histogramTime = 0;

for (const [pkg, r1, r2, r3] of triples) {
  const dirs = [r1, r2, r3].map((v) => dirOf(pkg, v));
  if (!dirs.every(existsSync)) continue;
  const in2 = new Set(walk(dirs[1]));
  const in3 = new Set(walk(dirs[2]));
  for (const rel of walk(dirs[0])) {
    if (!in2.has(rel) || !in3.has(rel)) continue;
    const [v1, v2, v3] = dirs.map((d) => readFileSync(join(d, rel)));
    if ([v1, v2, v3].some((v) => v.subarray(0, 8000).includes(0))) continue;
    const [t1, t2, t3] = [v1, v2, v3].map((v) => v.toString('utf8'));
    for (const [ours, base, theirs] of [[t2, t1, t3], [t1, t2, t3]]) {
      if (ours === base || theirs === base) continue;
      merges++;
      let t = performance.now();
      const git = merge(ours, base, theirs);
      hunksTime += performance.now() - t;
      t = performance.now();
      merge(ours, base, theirs, { algorithm: 'histogram', level: 'zealous' });
      histogramTime += performance.now() - t;
      const [a, o, b] = [ours, base, theirs].map((s) => s.split('\n'));
      for (const [name, run] of [['node-diff3', () => nodeDiff3.diff3Merge(a, o, b)], ['diff3', () => diff3(a, o, b)]] as const) {
        const r = results[name];
        t = performance.now();
        const blocks = run();
        r.time += performance.now() - t;
        const conflicts = blocks.filter((x) => x.conflict).length;
        if (git.conflicts === 0 && conflicts === 0) {
          if (render(blocks) === git.merged) r.same++;
          else r.cleanButDifferent++;
        } else if (git.conflicts === 0) r.falseConflict++;
        else if (conflicts === 0) r.missedConflict++;
        else {
          r.bothConflict++;
          if (render(blocks) === git.merged) r.bothConflictSame++;
        }
      }
    }
  }
}

console.log(`${merges} merges of real files where both sides changed the file`);
console.log(`hunks: ${hunksTime.toFixed(0)} ms in all as git merge-file (myers), ${histogramTime.toFixed(0)} ms as git merge (histogram)\n`);
for (const [name, r] of Object.entries(results)) {
  console.log(`${name}: ${r.time.toFixed(0)} ms in all`);
  console.log(`  clean, same text as git        ${r.same}`);
  console.log(`  clean, different text from git ${r.cleanButDifferent}`);
  console.log(`  conflict where git is clean    ${r.falseConflict}`);
  console.log(`  clean where git has a conflict ${r.missedConflict}`);
  console.log(`  conflicts on both              ${r.bothConflict} (text as git writes it: ${r.bothConflictSame})`);
}
