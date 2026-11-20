/**
 * Cross-checks on a corpus of real file pairs (see scripts/corpus.ts and
 * scripts/fetch-corpus.ts):
 *
 *   1. patch() on strings equals git's output decoded as UTF-8
 *   2. diff() rebuilt into text equals patch()
 *   3. edits() applied to the old lines reproduce the new lines
 *   4. inline spans are sorted, disjoint, non-empty and inside the line
 *
 *   node scripts/consistency.ts <corpus-dir>
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { diff, edits, patch, type Algorithm } from '../src/index.ts';
import { gitPatch, gitFlags } from '../test/git.ts';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/consistency.ts <corpus-dir>');
  process.exit(2);
}

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

const strict = new TextDecoder('utf-8', { fatal: true });
const lenient = new TextDecoder();
const failures: Record<string, string[]> = { text: [], rebuild: [], edits: [], spans: [] };
let checked = 0;
let skippedNonUtf8 = 0;

const pairs = readFileSync(join(root, 'pairs.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
for (const [name, va, vb] of pairs) {
  const A = join(root, `${name.replace('/', '+')}@${va}`, 'package');
  const B = join(root, `${name.replace('/', '+')}@${vb}`, 'package');
  if (!existsSync(A) || !existsSync(B)) continue;
  const inB = new Set(walk(B));
  for (const rel of walk(A)) {
    if (!inB.has(rel)) continue;
    const ab = readFileSync(join(A, rel));
    const bb = readFileSync(join(B, rel));
    if (ab.equals(bb)) continue;
    let a: string;
    let b: string;
    try {
      a = strict.decode(ab);
      b = strict.decode(bb);
    } catch {
      skippedNonUtf8++;
      continue;
    }
    const where = `${name} ${va}->${vb} ${rel}`;
    for (const algorithm of ['myers', 'minimal', 'patience', 'histogram'] as Algorithm[]) {
      checked++;
      const text = patch(a, b, { algorithm });

      // 1. String mode against git.
      const expected = lenient.decode(gitPatch(ab, bb, gitFlags({ algorithm })));
      if (text !== expected) failures.text.push(`${where} [${algorithm}]`);

      // 2. diff() and patch() tell the same story.
      const d = diff(a, b, { algorithm, inline: true });
      let rebuilt = '';
      for (const h of d.hunks) {
        rebuilt += h.header + '\n';
        for (const l of h.lines) {
          rebuilt += (l.type === 'context' ? ' ' : l.type === 'removed' ? '-' : '+') + l.text + (l.newline ? '\n' : '\n\\ No newline at end of file\n');
        }
      }
      if (rebuilt !== text) failures.rebuild.push(`${where} [${algorithm}]`);

      // 3. The edit script turns old into new.
      const oldLines = a.split(/(?<=\n)/);
      const newLines = b.split(/(?<=\n)/);
      const out: string[] = [];
      let i = 0;
      for (const e of edits(a, b, { algorithm })) {
        out.push(...oldLines.slice(i, e.oldStart), ...newLines.slice(e.newStart, e.newEnd));
        i = e.oldEnd;
      }
      out.push(...oldLines.slice(i));
      if (out.join('') !== b) failures.edits.push(`${where} [${algorithm}]`);

      // 4. Spans are well formed.
      for (const h of d.hunks) {
        for (const l of h.lines) {
          if (!l.spans) continue;
          let prev = -1;
          for (const [s, e] of l.spans) {
            if (!(s > prev && s < e && e <= l.text.length)) {
              failures.spans.push(`${where} [${algorithm}] line ${l.oldNumber ?? l.newNumber}: ${JSON.stringify(l.spans)}`);
              break;
            }
            prev = e;
          }
        }
      }
    }
  }
}

console.log(`${checked} file-and-algorithm combinations checked (${skippedNonUtf8} non-UTF-8 files skipped)`);
for (const [k, v] of Object.entries(failures)) {
  console.log(`  ${k.padEnd(8)} ${v.length === 0 ? 'ok' : `${v.length} FAILURES, e.g. ${v.slice(0, 3).join('; ')}`}`);
}
process.exitCode = Object.values(failures).some((v) => v.length) ? 1 : 0;
