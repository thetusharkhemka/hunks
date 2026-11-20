/**
 * Three-way merges by the git binary, for comparison with merge():
 *
 *   mergeFile   git merge-file -p, which covers the default level
 *               (zealous-alnum), every style, favor, marker size and label;
 *   mergeTree   git merge-tree, which runs the merge of `git merge`
 *               (level zealous) and takes -X options: every diff algorithm
 *               and whitespace option (before git 2.50, histogram only);
 *   mergeRecursive  git merge -s recursive, for the other algorithms on a
 *               git older than 2.50.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MergeOptions } from '../src/index.ts';

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'a',
  GIT_AUTHOR_EMAIL: 'a@a',
  GIT_COMMITTER_NAME: 'a',
  GIT_COMMITTER_EMAIL: 'a@a',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

let workdir: string | null = null;
function dir(): string {
  if (!workdir) {
    workdir = mkdtempSync(join(tmpdir(), 'hunks-merge-'));
    execFileSync('git', ['init', '-q', workdir], { env });
    process.on('exit', () => rmSync(workdir!, { recursive: true, force: true }));
  }
  return workdir;
}

export interface GitMerge {
  merged: Uint8Array;
  /** git merge-file: the number of conflicts, capped at 127. git merge-tree: 1 if any. */
  status: number;
}

/** `git merge-file -p` with the options it has; labels are always given. */
export function mergeFile(ours: Uint8Array, base: Uint8Array, theirs: Uint8Array, o: MergeOptions): GitMerge {
  const d = dir();
  writeFileSync(join(d, 'ours'), ours);
  writeFileSync(join(d, 'base'), base);
  writeFileSync(join(d, 'theirs'), theirs);
  const args = ['merge-file', '-p', '-q'];
  if (o.style === 'diff3') args.push('--diff3');
  if (o.style === 'zdiff3') args.push('--zdiff3');
  if (o.favor) args.push(`--${o.favor}`);
  if (o.markerSize !== undefined) args.push(`--marker-size=${o.markerSize}`);
  const l = o.labels ?? {};
  args.push('-L', l.ours ?? 'ours', '-L', l.base ?? 'base', '-L', l.theirs ?? 'theirs', 'ours', 'base', 'theirs');
  const r = spawnSync('git', args, { cwd: d, env, maxBuffer: 1 << 30 });
  if (r.status === null || r.status > 127) throw new Error(`git merge-file failed: ${r.stderr}`);
  return { merged: new Uint8Array(r.stdout), status: r.status };
}

/**
 * The content merge of `git merge`, through merge-tree. The branches are
 * named by their commit ids, so those are the labels; the base is labelled
 * with its abbreviated id.
 */
export function mergeTree(ours: Uint8Array, base: Uint8Array, theirs: Uint8Array, o: MergeOptions): GitMerge & { labels: { ours: string; base: string; theirs: string } } {
  const d = dir();
  writeFileSync(join(d, 'ours'), ours);
  writeFileSync(join(d, 'base'), base);
  writeFileSync(join(d, 'theirs'), theirs);
  const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: d, env, input, maxBuffer: 1 << 30 }).toString().trim();
  const [blobBase, blobOurs, blobTheirs] = git(['hash-object', '-w', 'base', 'ours', 'theirs']).split('\n');
  const trees = git(['mktree', '--batch'], [blobBase, blobOurs, blobTheirs].map((b) => `100644 blob ${b}\tf\n`).join('\n')).split('\n');
  const commitBase = git(['commit-tree', trees[0], '-m', 'base']);
  const commitOurs = git(['commit-tree', trees[1], '-p', commitBase, '-m', 'ours']);
  const commitTheirs = git(['commit-tree', trees[2], '-p', commitBase, '-m', 'theirs']);
  const args = ['-c', `merge.conflictStyle=${o.style ?? 'merge'}`, 'merge-tree', '--write-tree', '-X', `diff-algorithm=${o.algorithm ?? 'myers'}`];
  if (o.ignoreWhitespace) args.push('-X', 'ignore-all-space');
  if (o.ignoreWhitespaceChange) args.push('-X', 'ignore-space-change');
  if (o.ignoreWhitespaceAtEol) args.push('-X', 'ignore-space-at-eol');
  if (o.ignoreCrAtEol) args.push('-X', 'ignore-cr-at-eol');
  if (o.favor === 'ours' || o.favor === 'theirs') args.push('-X', o.favor);
  args.push(commitOurs, commitTheirs);
  const r = spawnSync('git', args, { cwd: d, env, maxBuffer: 1 << 30 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git merge-tree failed: ${r.stderr}`);
  const tree = r.stdout.toString().split('\n')[0];
  const merged = execFileSync('git', ['cat-file', 'blob', `${tree}:f`], { cwd: d, env, maxBuffer: 1 << 30 });
  return {
    merged: new Uint8Array(merged),
    status: r.status,
    labels: { ours: commitOurs, base: git(['rev-parse', '--short', commitBase]), theirs: commitTheirs },
  };
}

let worktree: string | null = null;
function tree(): string {
  if (!worktree) {
    worktree = mkdtempSync(join(tmpdir(), 'hunks-merge-recursive-'));
    execFileSync('git', ['init', '-q', worktree], { env });
    process.on('exit', () => rmSync(worktree!, { recursive: true, force: true }));
  }
  return worktree;
}

/**
 * The content merge of `git merge -s recursive`. Before git 2.50 this is the
 * only merge that honours -X diff-algorithm (merge-ort used histogram,
 * always), so it is how myers, minimal and patience merges are checked
 * against older git. Labels: HEAD, the base's abbreviated id, their id.
 */
export function mergeRecursive(ours: Uint8Array, base: Uint8Array, theirs: Uint8Array, o: MergeOptions): GitMerge & { labels: { ours: string; base: string; theirs: string } } {
  const d = tree();
  const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: d, env, input, maxBuffer: 1 << 30 }).toString().trim();
  writeFileSync(join(d, '.base'), base);
  writeFileSync(join(d, '.ours'), ours);
  writeFileSync(join(d, '.theirs'), theirs);
  const [blobBase, blobOurs, blobTheirs] = git(['hash-object', '-w', '.base', '.ours', '.theirs']).split('\n');
  const trees = git(['mktree', '--batch'], [blobBase, blobOurs, blobTheirs].map((b) => `100644 blob ${b}\tf\n`).join('\n')).split('\n');
  const commitBase = git(['commit-tree', trees[0], '-m', 'base']);
  const commitOurs = git(['commit-tree', trees[1], '-p', commitBase, '-m', 'ours']);
  const commitTheirs = git(['commit-tree', trees[2], '-p', commitBase, '-m', 'theirs']);
  git(['reset', '-q', '--hard', commitOurs]);
  const args = ['-c', `merge.conflictStyle=${o.style ?? 'merge'}`, 'merge', '-q', '--no-edit', '-s', 'recursive', '-X', `diff-algorithm=${o.algorithm ?? 'myers'}`];
  if (o.ignoreWhitespace) args.push('-X', 'ignore-all-space');
  if (o.ignoreWhitespaceChange) args.push('-X', 'ignore-space-change');
  if (o.ignoreWhitespaceAtEol) args.push('-X', 'ignore-space-at-eol');
  if (o.ignoreCrAtEol) args.push('-X', 'ignore-cr-at-eol');
  if (o.favor === 'ours' || o.favor === 'theirs') args.push('-X', o.favor);
  args.push(commitTheirs);
  const r = spawnSync('git', args, { cwd: d, env, maxBuffer: 1 << 30 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git merge failed: ${r.stderr}`);
  const merged = readMerged(d, r.status);
  return { merged, status: r.status, labels: { ours: 'HEAD', base: git(['rev-parse', '--short', commitBase]), theirs: commitTheirs } };
}

/** The merged file: committed when the merge was clean, in the worktree when not. */
function readMerged(d: string, status: number): Uint8Array {
  if (status === 0) return new Uint8Array(execFileSync('git', ['cat-file', 'blob', 'HEAD:f'], { cwd: d, env, maxBuffer: 1 << 30 }));
  return new Uint8Array(readFileSync(join(d, 'f')));
}
