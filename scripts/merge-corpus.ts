/**
 * Three-way merges of real code, compared with `git merge-file -p`.
 *
 *   node scripts/merge-corpus.ts <corpus-dir>
 *
 * Uses the corpus of scripts/corpus.ts, with triples.txt listing three
 * consecutive releases of a package per line: `name r1 r2 r3`. Without it,
 * pairs that chain (r1 -> r2, r2 -> r3) are used. Every text file present
 * in all three releases is merged two ways: r2 and r3 as edits of r1, and
 * r1 and r3 as edits of r2, which undoes one release while applying the
 * next, and so conflicts often. Each merge runs in every conflict style.
 *
 * With --git-merge, merges where both sides changed the file also go
 * through `git merge-tree`, the merge of `git merge`: histogram, level
 * zealous.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { merge, type MergeOptions } from '../src/index.ts';
import { gitVersion } from '../test/git.ts';
import { mergeFile, mergeTree } from '../test/merge-git.ts';
import { compat } from '../src/core/compat.ts';

compat.git = gitVersion;

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/merge-corpus.ts <corpus-dir>');
  process.exit(2);
}

const pairs = readFileSync(join(root, 'pairs.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
const dirOf = (pkg: string, v: string) => join(root, `${pkg.replace('/', '+')}@${v}`, 'package');

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

const triples: [string, string, string, string][] = [];
if (existsSync(join(root, 'triples.txt'))) {
  for (const line of readFileSync(join(root, 'triples.txt'), 'utf8').trim().split('\n')) {
    const [pkg, a, b, c] = line.split(/\s+/);
    triples.push([pkg, a, b, c]);
  }
} else {
  // Chain consecutive pairs: a -> b and b -> c give (a, b, c).
  for (const [pkg, a, b] of pairs) {
    for (const [pkg2, b2, c] of pairs) {
      if (pkg2 === pkg && b2 === b) triples.push([pkg, a, b, c]);
    }
  }
}

const STYLES: MergeOptions['style'][] = ['merge', 'diff3', 'zdiff3'];
const gitMerge = process.argv.includes('--git-merge');
let merges = 0;
let mismatches = 0;
let conflicted = 0;
const t0 = performance.now();
for (const [pkg, r1, r2, r3] of triples) {
  const [d1, d2, d3] = [r1, r2, r3].map((v) => dirOf(pkg, v));
  if (![d1, d2, d3].every(existsSync)) continue;
  const in2 = new Set(walk(d2));
  const in3 = new Set(walk(d3));
  let files = 0;
  for (const rel of walk(d1)) {
    if (!in2.has(rel) || !in3.has(rel)) continue;
    const [v1, v2, v3] = [d1, d2, d3].map((d) => new Uint8Array(readFileSync(join(d, rel))));
    if ([v1, v2, v3].some((v) => v.subarray(0, 8000).includes(0))) continue;
    files++;
    for (const [ours, base, theirs] of [[v2, v1, v3], [v1, v2, v3]]) {
      for (const style of STYLES) {
        const options: MergeOptions = { style, labels: { ours: 'ours', base: 'base', theirs: 'theirs' } };
        const expected = mergeFile(ours, base, theirs, options);
        const actual = merge(ours, base, theirs, options);
        merges++;
        if (actual.conflicts > 0) conflicted++;
        const same = actual.merged.length === expected.merged.length && actual.merged.every((x, i) => x === expected.merged[i]);
        if (!same || Math.min(actual.conflicts, 127) !== expected.status) {
          mismatches++;
          if (mismatches <= 5) console.log(`MISMATCH ${pkg} ${r1}/${r2}/${r3} ${rel} style=${style}`);
        }
      }
      const changed = (x: Uint8Array) => x.length !== base.length || x.some((v, i) => v !== base[i]);
      if (gitMerge && changed(ours) && changed(theirs)) {
        const options: MergeOptions = { algorithm: 'histogram', level: 'zealous' };
        const expected = mergeTree(ours, base, theirs, options);
        const actual = merge(ours, base, theirs, { ...options, labels: expected.labels });
        merges++;
        if (actual.conflicts > 0) conflicted++;
        const same = actual.merged.length === expected.merged.length && actual.merged.every((x, i) => x === expected.merged[i]);
        if (!same || (actual.conflicts > 0 ? 1 : 0) !== expected.status) {
          mismatches++;
          if (mismatches <= 5) console.log(`MISMATCH (git merge) ${pkg} ${r1}/${r2}/${r3} ${rel}`);
        }
      }
    }
  }
  console.log(`${pkg.padEnd(14)} ${r1} -> ${r2} -> ${r3}: ${files} files`);
}
const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\n${merges - mismatches}/${merges} merges of real files identical to git (${conflicted} with conflicts) in ${secs}s`);
process.exitCode = mismatches ? 1 : 0;
