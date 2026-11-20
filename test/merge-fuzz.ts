/**
 * Differential fuzzing of merge() against git: generated three-way merges,
 * half through `git merge-file`, half through `git merge-tree`.
 *
 *   node test/merge-fuzz.ts [iterations] [seed]
 */

import { compat } from '../src/core/compat.ts';
import { merge, type MergeOptions } from '../src/index.ts';
import { generate, mutate, pick, render, rng, type Doc } from './fuzz.ts';
import { gitVersion } from './git.ts';
import { mergeFile, mergeRecursive, mergeTree } from './merge-git.ts';

compat.git = gitVersion;

const LABELS = ['ours', 'HEAD', 'feature/x', 'with space', 'café', ''];

export interface MergeCase {
  seed: number;
  harness: 'merge-file' | 'merge-tree' | 'merge-recursive';
  options: MergeOptions;
  ours: Uint8Array;
  base: Uint8Array;
  theirs: Uint8Array;
}

export function generateCase(seed: number): MergeCase {
  const r = rng(seed);
  const docBase = generate(r);
  const docOurs = mutate(r, docBase);
  // Some overlap is what makes merging interesting: theirs is sometimes
  // built on ours, sometimes the same, usually independent.
  const shape = r();
  const docTheirs: Doc = shape < 0.2 ? mutate(r, docOurs) : shape < 0.27 ? docOurs : mutate(r, docBase);
  const base = render(docBase, r() > 0.15);
  const ours = render(docOurs, r() > 0.15);
  const theirs = render(docTheirs, r() > 0.15);

  // Before 2.50, merge-tree always used histogram; merge -s recursive
  // honours the other algorithms there.
  const h = r();
  const harness = h < 0.4 ? 'merge-file' : h < 0.7 || gitVersion >= 250 ? 'merge-tree' : 'merge-recursive';
  const o: MergeOptions = {};
  const style = r();
  if (style < 0.25) o.style = 'diff3';
  else if (style < 0.5) o.style = 'zdiff3';
  if (harness === 'merge-file') {
    const favor = r();
    if (favor < 0.08) o.favor = 'ours';
    else if (favor < 0.16) o.favor = 'theirs';
    else if (favor < 0.24) o.favor = 'union';
    if (r() < 0.2) o.markerSize = 1 + Math.floor(r() * 12);
    if (r() < 0.5) o.labels = { ours: pick(r, LABELS), base: pick(r, LABELS), theirs: pick(r, LABELS) };
  } else {
    o.level = 'zealous';
    o.algorithm = harness === 'merge-tree' && gitVersion < 250 ? 'histogram' : pick(r, ['myers', 'minimal', 'patience', 'histogram'] as const);
    if (r() < 0.12) o.ignoreWhitespace = true;
    if (r() < 0.12) o.ignoreWhitespaceChange = true;
    if (r() < 0.12) o.ignoreWhitespaceAtEol = true;
    if (r() < 0.12) o.ignoreCrAtEol = true;
    const favor = r();
    if (favor < 0.08) o.favor = 'ours';
    else if (favor < 0.16) o.favor = 'theirs';
  }
  return { seed, harness, options: o, ours, base, theirs };
}

export interface MergeMismatch {
  expected: string;
  actual: string;
  expectedStatus: number;
  actualConflicts: number;
}

/** Run one case through git and merge(); returns the difference, if any. */
export function checkCase(c: MergeCase): MergeMismatch | null {
  const dec = new TextDecoder('latin1');
  let expected;
  let options = c.options;
  if (c.harness === 'merge-file') {
    expected = mergeFile(c.ours, c.base, c.theirs, options);
    options = { ...options, labels: { ours: 'ours', base: 'base', theirs: 'theirs', ...options.labels } };
  } else {
    expected = c.harness === 'merge-tree' ? mergeTree(c.ours, c.base, c.theirs, options) : mergeRecursive(c.ours, c.base, c.theirs, options);
    options = { ...options, labels: expected.labels };
  }
  const actual = merge(c.ours, c.base, c.theirs, options);
  const status = c.harness === 'merge-file' ? Math.min(actual.conflicts, 127) : actual.conflicts > 0 ? 1 : 0;
  const same = actual.merged.length === expected.merged.length && actual.merged.every((v, i) => v === expected.merged[i]);
  if (same && status === expected.status) return null;
  return { expected: dec.decode(expected.merged), actual: dec.decode(actual.merged), expectedStatus: expected.status, actualConflicts: actual.conflicts };
}

if (import.meta.main) {
  const iterations = Number(process.argv[2] ?? 1000);
  const start = Number(process.argv[3] ?? Date.now() % 1e9);
  let failures = 0;
  const t0 = performance.now();
  const byHarness = { 'merge-file': 0, 'merge-tree': 0, 'merge-recursive': 0 };
  for (let i = 0; i < iterations; i++) {
    const c = generateCase(start + i);
    byHarness[c.harness]++;
    const m = checkCase(c);
    if (!m) continue;
    failures++;
    if (failures <= 3) {
      console.log(`\nseed ${c.seed}  ${c.harness}  options ${JSON.stringify(c.options)}`);
      console.log(`  status: git ${m.expectedStatus}, hunks ${m.actualConflicts} conflicts`);
      const e = m.expected.split('\n');
      const x = m.actual.split('\n');
      let k = 0;
      while (k < e.length && e[k] === x[k]) k++;
      console.log(`  first difference at line ${k + 1}`);
      console.log('  git:   ' + JSON.stringify(e.slice(Math.max(0, k - 3), k + 4)));
      console.log('  hunks: ' + JSON.stringify(x.slice(Math.max(0, k - 3), k + 4)));
    }
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\n${iterations - failures}/${iterations} merges identical to git (${byHarness['merge-file']} merge-file, ${byHarness['merge-tree']} merge-tree, ${byHarness['merge-recursive']} merge -s recursive; seeds ${start}..${start + iterations - 1}) in ${secs}s`);
  process.exitCode = failures ? 1 : 0;
}
