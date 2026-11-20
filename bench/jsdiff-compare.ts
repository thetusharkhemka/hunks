/**
 * On how many real files does jsdiff mark different lines as changed than
 * git does?
 *
 *   cd bench && npm install --ignore-scripts && node jsdiff-compare.ts <corpus-dir>
 *
 * The corpus comes from scripts/fetch-corpus.ts. For every text file that
 * changed between two releases, the sets of removed and added line numbers
 * from jsdiff's diffLines are compared with those of `git diff -U0`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const { diffLines } = require('diff') as { diffLines: (a: string, b: string) => { added?: boolean; removed?: boolean; count: number }[] };
const root = process.argv[2];
const pairs = readFileSync(join(root, 'pairs.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
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

type Sets = { del: Set<number>; ins: Set<number> };

/** Changed line numbers per file, from `git diff -U0` of two directories. */
function gitSets(a: string, b: string): Map<string, Sets> {
  let out: string;
  try {
    out = execFileSync('git', ['diff', '--no-index', '--no-color', '--no-renames', '-U0', a, b], {
      maxBuffer: 1 << 30,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  } catch (err) {
    out = (err as { stdout: string }).stdout;
  }
  const files = new Map<string, Sets>();
  const prefix = b.replace(/^\//, '') + '/';
  let cur: Sets | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) cur = null;
    else if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      cur = { del: new Set(), ins: new Set() };
      files.set(p.startsWith(prefix) ? p.slice(prefix.length) : p, cur);
    } else {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m && cur) {
        for (let i = 0; i < (m[2] === undefined ? 1 : +m[2]); i++) cur.del.add(+m[1] + i);
        for (let i = 0; i < (m[4] === undefined ? 1 : +m[4]); i++) cur.ins.add(+m[3] + i);
      }
    }
  }
  return files;
}

function jsdiffSets(a: string, b: string): Sets {
  const del = new Set<number>();
  const ins = new Set<number>();
  let o = 1;
  let n = 1;
  for (const c of diffLines(a, b)) {
    if (c.added) for (let i = 0; i < c.count; i++) ins.add(n++);
    else if (c.removed) for (let i = 0; i < c.count; i++) del.add(o++);
    else {
      o += c.count;
      n += c.count;
    }
  }
  return { del, ins };
}

const same = (x: Set<number>, y: Set<number>) => x.size === y.size && [...x].every((v) => y.has(v));
let files = 0;
let differ = 0;
for (const [pkg, va, vb] of pairs) {
  const A = dirOf(pkg, va);
  const B = dirOf(pkg, vb);
  if (!existsSync(A) || !existsSync(B)) continue;
  const git = gitSets(A, B);
  const inB = new Set(walk(B));
  for (const rel of walk(A)) {
    const g = git.get(rel);
    if (!inB.has(rel) || !g) continue;
    const a = readFileSync(join(A, rel));
    const b = readFileSync(join(B, rel));
    if (a.includes(0) || b.includes(0)) continue;
    files++;
    const j = jsdiffSets(a.toString('utf8'), b.toString('utf8'));
    if (!same(j.del, g.del) || !same(j.ins, g.ins)) differ++;
  }
}
const version = require('diff/package.json').version;
console.log(`jsdiff ${version}: ${differ} of ${files} changed files differ from git (${((100 * differ) / files).toFixed(1)}%)`);
