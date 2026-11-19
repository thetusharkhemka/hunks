/**
 * Helpers for comparing against the real git binary.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compat } from '../src/core/compat.ts';
import { patch, type PatchOptions } from '../src/index.ts';

export const gitVersion = (() => {
  const out = execFileSync('git', ['--version'], { encoding: 'utf8' });
  const m = /(\d+)\.(\d+)/.exec(out);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
})();

/** Imitate the git we compare against. */
compat.git = gitVersion;

/** Translate options into the equivalent git flags. */
export function gitFlags(o: PatchOptions): string[] {
  const f: string[] = [];
  if (o.algorithm) f.push(`--diff-algorithm=${o.algorithm}`);
  if (o.indentHeuristic === false) f.push('--no-indent-heuristic');
  if (o.ignoreWhitespace) f.push('-w');
  if (o.ignoreWhitespaceChange) f.push('-b');
  if (o.ignoreWhitespaceAtEol) f.push('--ignore-space-at-eol');
  if (o.ignoreCrAtEol) f.push('--ignore-cr-at-eol');
  if (o.ignoreBlankLines) f.push('--ignore-blank-lines');
  if (o.context !== undefined) f.push(`-U${o.context}`);
  if (o.interHunkContext !== undefined) f.push(`--inter-hunk-context=${o.interHunkContext}`);
  if (o.functionContext) f.push('-W');
  for (const a of [o.anchored ?? []].flat()) f.push(`--anchored=${a}`);
  for (const r of [o.ignoreMatchingLines ?? []].flat()) f.push(`-I${r.source}`);
  return f;
}

let dir: string | null = null;
function workdir(): string {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'hunks-parity-'));
    process.on('exit', () => rmSync(dir!, { recursive: true, force: true }));
  }
  return dir;
}

/** Run `git diff --no-index` and return the body (everything after `+++`). */
export function gitPatch(a: Uint8Array, b: Uint8Array, flags: string[]): Uint8Array {
  const d = workdir();
  const fa = join(d, 'a');
  const fb = join(d, 'b');
  writeFileSync(fa, a);
  writeFileSync(fb, b);
  const r = spawnSync('git', ['-c', 'core.quotepath=false', '-c', 'diff.noprefix=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--text', ...flags, fa, fb], {
    maxBuffer: 1 << 30,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
  });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git failed: ${r.stderr}`);
  const out: Buffer = r.stdout;
  // Skip header lines up to and including "+++ ".
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(10, pos);
    const line = out.subarray(pos, nl === -1 ? out.length : nl);
    pos = nl === -1 ? out.length : nl + 1;
    if (line[0] === 0x2b && line[1] === 0x2b && line[2] === 0x2b) return new Uint8Array(out.subarray(pos));
  }
  return new Uint8Array(0);
}

export interface Mismatch {
  flags: string[];
  expected: string;
  actual: string;
}

const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

/** Compare hunks with git for one input pair and option set. */
export function compare(a: Uint8Array, b: Uint8Array, options: PatchOptions): Mismatch | null {
  const flags = gitFlags(options);
  const expected = gitPatch(a, b, flags);
  const actual = patch(a, b, options);
  if (Buffer.from(expected).equals(Buffer.from(actual))) return null;
  return { flags, expected: latin1(expected), actual: latin1(actual) };
}
