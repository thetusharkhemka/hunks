import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const hasGit = spawnSync('git', ['--version']).status === 0;
let dir = '';

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, {
    cwd: dir,
    input,
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

function sameWithStdin(input: string, ...args: string[]): void {
  const g = run('git', ['diff', '--no-index', '--no-color', ...args], input);
  const h = run(process.execPath, [cli, '--no-color', ...args], input);
  assert.equal(h.out, g.out, `stdout for ${args.join(' ')} with stdin`);
  assert.equal(h.code, g.code, `exit code for ${args.join(' ')} with stdin`);
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
    symlinkSync('a.js', join(dir, 'link-a'));
    symlinkSync('b.js', join(dir, 'link-b'));
    symlinkSync('nowhere', join(dir, 'dangling'));
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

  test('symbolic links, standard input and git\'s flag syntax', { skip: (!hasGit || process.platform === 'win32') && 'needs git and symlinks' }, () => {
    same('link-a', 'link-b');
    same('dangling', 'link-a');
    same('link-a', 'plain');
    same('plain', 'link-a');
    sameWithStdin('x\n', '-', 'plain');
    sameWithStdin('y\n', 'plain', '-');
    sameWithStdin('x\n', '-', '-');
    same('--unified', 'a.js', 'b.js');
    same('--unified=1', 'a.js', 'b.js');
    same('-U', 'a.js', 'b.js');
    same('-wb', 'ws1', 'ws2');
    same('-wU1', 'a.js', 'b.js');
    same('--diff-algorithm=Histogram', 'a.js', 'b.js');
    same('-I', '^function', 'a.js', 'b.js');
    same('--quiet', 'a.js', 'b.js');
    same('--quiet', 'a.js', 'a.js');
    for (const flag of ['-p', '-u', '--patch', '--exit-code', '--no-index', '--no-ext-diff']) same(flag, 'a.js', 'b.js');
  });

  test('every option behaves as the git flag of the same name', { skip: !hasGit && 'git not installed' }, () => {
    writeFileSync(join(dir, 'crlf1'), 'a \r\nb\r\n\r\nfunction x\r\nc\n');
    writeFileSync(join(dir, 'crlf2'), 'a\r\nb\n\n\nfunction x\nc  \n');
    writeFileSync(join(dir, '-dash'), 'function a() {\n}\n');
    const flags = [
      ['--diff-algorithm=minimal'], ['--diff-algorithm', 'patience'], ['--diff-algorithm=default'],
      ['--minimal'], ['--patience'], ['--histogram'],
      ['--anchored=function'], ['--anchored', 'function'], ['--indent-heuristic'], ['--no-indent-heuristic'],
      ['--inter-hunk-context=3'], ['--inter-hunk-context', '3'], ['--function-context'],
      ['--ignore-all-space'], ['--ignore-space-change'], ['--ignore-space-at-eol'], ['--ignore-cr-at-eol'],
      ['--ignore-blank-lines'], ['--ignore-matching-lines=^function'], ['--ignore-matching-lines', '^function'],
      ['--text'], ['-a'], ['--unified=0'], ['-U0'], ['-Ifunction'],
    ];
    for (const f of flags) {
      same(...f, 'a.js', 'b.js');
      same(...f, 'crlf1', 'crlf2');
    }
    same('--', '-dash', 'a.js');
  });

  test('algorithm flags apply in order, as in git', { skip: !hasGit && 'git not installed' }, () => {
    const lines = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const moved = [...lines];
    moved.splice(5, 0, 'l30');
    moved.splice(31, 1);
    moved[10] = 'X';
    moved.splice(20, 0, 'l2');
    writeFileSync(join(dir, 'anc-a'), lines.join('\n') + '\n');
    writeFileSync(join(dir, 'anc-b'), moved.join('\n') + '\n');
    // --anchored switches to patience; a later algorithm flag switches away,
    // and --patience also drops the anchors given before it.
    for (const flags of [
      ['--anchored=l30', '--histogram'], ['--histogram', '--anchored=l30'],
      ['--anchored=l30', '--diff-algorithm=myers'], ['--anchored=l30', '--patience'],
      ['--patience', '--anchored=l30', '--anchored=l2'], ['--anchored=l30', '--histogram', '--diff-algorithm=patience'],
      ['--anchored=l30', '--histogram', '--patience'], ['--minimal', '--histogram'],
    ]) {
      same(...flags, 'anc-a', 'anc-b');
    }
  });

  test('reports missing values and files it cannot compare', () => {
    assert.match(hunks('a.js', 'b.js', '-I').err, /-I expects a pattern/);
    assert.match(hunks('a.js', 'b.js', '--anchored').err, /--anchored expects a value/);
    assert.match(hunks('--inter-hunk-context=x', 'a.js', 'b.js').err, /expects a number/);
    assert.match(hunks('--color=sometimes', 'a.js', 'b.js').err, /--color expects always, never or auto/);
    const d = hunks('.', 'a.js');
    assert.equal(d.code, 2);
    assert.match(d.err, /'\.' is a directory/);
  });

  test('a file it may not read', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'root can read anything' }, () => {
    writeFileSync(join(dir, 'secret'), 'x\n');
    chmodSync(join(dir, 'secret'), 0);
    const r = hunks('secret', 'a.js');
    assert.equal(r.code, 2);
    assert.equal(r.err, "hunks: could not read 'secret' (permission denied)\n");
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
    assert.equal(hunks('-x', 'a.js', 'b.js').code, 2);
    assert.equal(hunks('-I', '(', 'a.js', 'b.js').code, 2);
    assert.equal(hunks('--quiet=yes', 'a.js', 'b.js').code, 2);
    const missing = hunks('nope', 'a.js');
    assert.equal(missing.code, 2);
    assert.match(missing.err, /could not access 'nope'/);
  });

  test('--help and --version', () => {
    assert.match(hunks('--help').out, /Usage: hunks/);
    assert.match(hunks('--version').out, /^\d+\.\d+\.\d+\n$/);
  });
});

describe('cli merge-file', () => {
  let mdir = '';
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const runIn = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd: mdir, env });
    return { out: r.stdout.toString('latin1'), err: r.stderr.toString(), code: r.status };
  };
  const git = (...args: string[]) => runIn('git', ['merge-file', ...args]);
  const hunks = (...args: string[]) => runIn(process.execPath, [cli, 'merge-file', ...args]);
  const same = (...args: string[]) => {
    const g = git(...args);
    const h = hunks(...args);
    assert.equal(h.out, g.out, `output for ${args.join(' ')}`);
    assert.equal(h.code, g.code, `exit status for ${args.join(' ')}`);
  };

  before(() => {
    mdir = mkdtempSync(join(tmpdir(), 'hunks-merge-cli-'));
    const files: Record<string, string | Buffer> = {
      base: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n',
      ours: 'one\nTWO\nthree\nfour\nfive\nsix\nSEVEN\n',
      theirs: 'one\n2\nthree\nfour\nfive\nsix\n7\n',
      clean: 'one\ntwo\nthree\nfour\nfive\nsix\nseven!\n',
      bin: Buffer.from('one\0two\n'),
      many_base: Array.from({ length: 200 }, (_, i) => `${i}\na\nb\nc\nd\n`).join(''),
      many_ours: Array.from({ length: 200 }, (_, i) => `O${i}\na\nb\nc\nd\n`).join(''),
      many_theirs: Array.from({ length: 200 }, (_, i) => `T${i}\na\nb\nc\nd\n`).join(''),
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(mdir, name), content);
  });
  after(() => rmSync(mdir, { recursive: true, force: true }));

  test('prints what git merge-file -p prints, with the same exit status', { skip: !hasGit && 'git not installed' }, () => {
    const flags = [
      [], ['--diff3'], ['--zdiff3'], ['--ours'], ['--theirs'], ['--union'],
      ['--marker-size=3'], ['--marker-size', '0'], ['--marker-size=-2'],
      ['-L', 'mine', '-L', 'old'], ['-Lmine', '-Lold', '-Lyours'], ['-pq'],
      ['--zdiff3', '--no-diff3'], ['--union', '--no-ours'], ['--stdout'],
    ];
    for (const f of flags) same('-p', ...f, 'ours', 'base', 'theirs');
    same('-p', 'clean', 'base', 'theirs');
    same('-p', 'ours', 'base', 'base');
  });

  test('writes the result into the first file, as git does', { skip: !hasGit && 'git not installed' }, () => {
    writeFileSync(join(mdir, 'g'), 'one\nTWO\nthree\nfour\nfive\nsix\nSEVEN\n');
    writeFileSync(join(mdir, 'h'), 'one\nTWO\nthree\nfour\nfive\nsix\nSEVEN\n');
    const g = git('g', 'base', 'theirs');
    const h = hunks('h', 'base', 'theirs');
    assert.equal(h.code, g.code);
    assert.equal(h.out, '');
    assert.equal(readFileSync(join(mdir, 'h'), 'utf8'), readFileSync(join(mdir, 'g'), 'utf8').replaceAll('<<<<<<< g', '<<<<<<< h'));
  });

  test('the exit status counts conflicts, up to 127', { skip: !hasGit && 'git not installed' }, () => {
    same('-p', 'many_ours', 'many_base', 'many_theirs');
    assert.equal(hunks('-p', 'many_ours', 'many_base', 'many_theirs').code, 127);
  });

  test('errors exit with 255 and usage errors with 129, as in git', { skip: !hasGit && 'git not installed' }, () => {
    for (const args of [['-p', 'nope', 'base', 'theirs'], ['-p', 'bin', 'base', 'theirs'], ['-p', '.', 'base', 'theirs']]) {
      assert.equal(hunks(...args).code, git(...args).code, args.join(' '));
      assert.equal(hunks(...args).code, 255);
    }
    for (const args of [['-p', 'ours', 'base'], ['-p', '-L', 'a', '-L', 'b', '-L', 'c', '-L', 'd', 'ours', 'base', 'theirs'], ['--bogus', 'ours', 'base', 'theirs']]) {
      assert.equal(hunks(...args).code, 129, args.join(' '));
      assert.equal(git(...args).code, 129, args.join(' '));
    }
    assert.match(hunks('-p', 'bin', 'base', 'theirs').err, /cannot merge binary files: 'bin'/);
    assert.equal(hunks('-q', '-p', 'nope', 'base', 'theirs').err, '');
  });
});
