import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const hasGit = spawnSync('git', ['--version']).status === 0;
let dir = '';

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', NO_COLOR: '' },
  });
  return { out: r.stdout.toString('latin1'), err: r.stderr.toString(), code: r.status };
}

const hunks = (...args: string[]) => run(process.execPath, [cli, '--no-color', ...args]);
const git = (...args: string[]) => run('git', ['diff', '--no-index', '--no-color', ...args]);

function same(...args: string[]): void {
  const g = git(...args);
  const h = hunks(...args);
  assert.equal(h.out, g.out, `stdout for ${args.join(' ')}`);
  assert.equal(h.code, g.code, `exit code for ${args.join(' ')}`);
}

describe('cli', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hunks-cli-'));
    const files: Record<string, string | Buffer> = {
      'a.js': 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n',
      'b.js': 'function a() {\n  return 1;\n}\n\nfunction c() {\n  return 3;\n}\n\nfunction b() {\n  return 2;\n}\n',
      'with space.txt': 'one\ntwo\n',
      'café.txt': 'one\nthree\n',
      'ws1': 'a  b\n',
      'ws2': 'a b\n',
      'bin1': Buffer.from('bin\0ary\n'),
      'bin2': Buffer.from('bin\0ari\n'),
      'empty': '',
      'exec': 'x\n',
      'plain': 'x\n',
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    chmodSync(join(dir, 'exec'), 0o755);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('matches git diff --no-index, headers and exit code included', { skip: !hasGit && 'git not installed' }, () => {
    same('a.js', 'b.js');
    same('--histogram', 'a.js', 'b.js');
    same('-U1', 'a.js', 'b.js');
    same('-W', 'a.js', 'b.js');
    same('with space.txt', 'café.txt');
    same('ws1', 'ws2');
    same('-w', 'ws1', 'ws2');
    same('bin1', 'bin2');
    same('exec', 'plain');
    same('a.js', 'a.js');
    same('/dev/null', 'a.js');
    same('a.js', '/dev/null');
    same('empty', 'a.js');
  });

  test('colour output highlights changed words', () => {
    writeFileSync(join(dir, 'c1'), 'const total = price * quantity;\n');
    writeFileSync(join(dir, 'c2'), 'const total = price * amount;\n');
    const r = run(process.execPath, [cli, '--color=always', 'c1', 'c2']);
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('\x1b[7mquantity\x1b[27m'), r.out);
    assert.ok(r.out.includes('\x1b[7mamount\x1b[27m'), r.out);
  });

  test('reports usage errors with exit code 2', () => {
    const r = hunks('only-one-file');
    assert.equal(r.code, 2);
    assert.match(r.err, /expected two files/);
    assert.equal(hunks('--diff-algorithm=quick', 'a.js', 'b.js').code, 2);
  });

  test('--help and --version', () => {
    assert.match(hunks('--help').out, /Usage: hunks/);
    assert.match(hunks('--version').out, /^\d+\.\d+\.\d+\n$/);
  });
});
