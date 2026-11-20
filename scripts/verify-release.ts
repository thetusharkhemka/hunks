/**
 * Checks that a version on npm is exactly what this source builds.
 *
 *   git checkout v1.2.1 && npm ci --ignore-scripts
 *   node scripts/verify-release.ts
 *
 * Builds and packs the checkout, then compares the tarball with the one the
 * registry serves: first the integrity hash of the whole tarball, then, if
 * that differs, file by file. Nothing from the downloaded tarball is run;
 * it is only hashed. Also reports the registry signature and whether the
 * version carries a provenance attestation.
 *
 * Exit status: 0 if identical, 1 if not, 2 on error.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version: string = process.argv[2] ?? pkg.version;
if (version !== pkg.version) {
  console.error(`This checkout is ${pkg.version}. Check out v${version} first.`);
  process.exit(2);
}
const spec = `${pkg.name}@${version}`;

const npm = (args: string[], cwd = process.cwd()) =>
  execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const work = mkdtempSync(join(tmpdir(), 'hunks-verify-'));
try {
  const published = JSON.parse(npm(['view', spec, 'dist', '--json']));

  npm(['run', 'build']);
  const [local] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', work]));

  console.log(`${spec}`);
  console.log(`  registry  ${published.integrity}`);
  console.log(`  local     ${local.integrity}`);
  console.log(`  signature ${published.signatures?.length ? 'present (npm audit signatures verifies it)' : 'none'}`);
  console.log(`  provenance ${published.attestations ? 'attested' : 'none (published without provenance)'}`);

  if (published.integrity === local.integrity) {
    console.log('\nIdentical: the published tarball is exactly what this source builds.');
    process.exit(0);
  }

  // Different: fetch the published tarball and compare the files in it.
  const [remote] = JSON.parse(npm(['pack', spec, '--json', '--ignore-scripts', '--pack-destination', join(work)]));
  const unpack = (file: string, into: string) => {
    execFileSync('mkdir', ['-p', into]);
    execFileSync('tar', ['-xzf', join(work, file), '-C', into]);
    return hashes(join(into, 'package'));
  };
  const ours = unpack(local.filename, join(work, 'local'));
  const theirs = unpack(remote.filename, join(work, 'registry'));
  console.log('\nDifferent. Files that differ:');
  for (const file of new Set([...ours.keys(), ...theirs.keys()])) {
    const a = ours.get(file);
    const b = theirs.get(file);
    if (a !== b) console.log(`  ${file}: ${a === undefined ? 'only on the registry' : b === undefined ? 'only here' : 'contents differ'}`);
  }
  process.exit(1);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function hashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(root);
  return out;
}
