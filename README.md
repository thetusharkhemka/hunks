# hunks

**git's diff and merge engine, in TypeScript.**

hunks produces the same diffs as `git diff`, byte for byte: the same algorithms (Myers with git's heuristics, patience, histogram), the same placement of ambiguous changes, the same hunk headers. It merges as `git merge-file` and `git merge` do, conflict markers and all. No dependencies, no child processes, no WebAssembly. It runs in Node, Bun, Deno and the browser.

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@thetusharkhemka/hunks@1/media/demo.svg" alt="hunks comparing two versions of a TypeScript file, with changed words highlighted" width="602">
</p>

```sh
npm install @thetusharkhemka/hunks
```

```js
import { patch } from '@thetusharkhemka/hunks';

patch('function add(a, b) {\n  return a + b;\n}\n', 'function add(a, b) {\n  return a + b + 0;\n}\n');
// @@ -1,3 +1,3 @@
//  function add(a, b) {
// -  return a + b;
// +  return a + b + 0;
//  }
```

## Why

Most JavaScript diff libraries implement Myers' 1986 algorithm as published. It finds a smallest diff, but when there are several (there usually are), which one you get is an accident of the implementation. git spent a decade on this:

- It sets aside lines that cannot match before searching, and caps the cost of the search, so large rewrites stay fast.
- It slides ambiguous blocks of added or removed lines to where a person would put them. Michael Haggerty fitted this *indent heuristic* to 6,668 hand-rated cases from 29 projects: git's previous placement was wrong 65.9% of the time, the heuristic 2.2% ([git 433860f](https://github.com/git/git/commit/433860f3d0beb0c6f205290bd16cda413148f098)).
- It adopted histogram diff, which researchers found gives better diffs of source code, and recommend for it ([Nugroho, Hata & Matsumoto, 2020](https://doi.org/10.1007/s10664-019-09772-z)).

None of that reached JavaScript. Across 634 changed files from 20 popular npm releases, [`diff`](https://www.npmjs.com/package/diff) (jsdiff, around 200 million downloads a week) disagrees with git on 127, about one in five. Here is one, from Express 5.1.0. jsdiff:

```diff
 
 /**
+ * A list of lowercased HTTP methods that are supported by Node.js.
+ * @api private
+ */
+exports.methods = METHODS.map((method) => method.toLowerCase());
+
+/**
  * Return strong ETag for `body`.
```

git, and hunks:

```diff
 var querystring = require('querystring');
 
+/**
+ * A list of lowercased HTTP methods that are supported by Node.js.
+ * @api private
+ */
+exports.methods = METHODS.map((method) => method.toLowerCase());
+
 /**
  * Return strong ETag for `body`.
```

Both are correct. Only the second shows what the author did: jsdiff's version starts the new comment from its second line and takes the opening `/**` of the next one.

Then there is speed. Between react-dom 19.0 and 19.1, the 24,717-line client build was largely rewritten. jsdiff takes 8.5 seconds to diff it. hunks takes 114 ms, or 16 ms with histogram.

The usual way out is to spawn git. The [`git-diff`](https://www.npmjs.com/package/git-diff) package, with about 900,000 weekly downloads, does exactly that, which rules out browsers, edge runtimes and sandboxes.

Merging is in the same state. [`diff3`](https://www.npmjs.com/package/diff3) and [`node-diff3`](https://www.npmjs.com/package/node-diff3), about 4.5 million downloads a week together, implement the classic diff3 algorithm. Across 968 real merges in which both sides changed a file, their result differs from git's in 214 and 213, about one in five: mostly conflicts drawn differently, and three merges they complete where git stops to ask.

## Verified against git

Parity is not a goal, it is a test. The suite runs the git binary on the same input and compares bytes:

- **Real code.** 634 changed files from consecutive releases of express, eslint, webpack, react-dom, typescript, three, vue, lodash and others, under 11 option sets. All identical.
- **Generated code.** 180,000 cases built to break diff engines: heavy duplication, sliding blocks, CRLF, missing final newlines, invalid UTF-8, multibyte function names at the 80-byte header limit, and random combinations of every option. All identical.
- **Merges.** 34,220 three-way merges of real files, each built from three consecutive releases of the projects above (1,930 of them with conflicts), and 44,500 generated merges. They are checked against `git merge-file` (every conflict style, every way of settling conflicts, marker sizes, labels), `git merge-tree` and `git merge` (every diff algorithm and whitespace option). All identical, conflict counts included.
- **The corners.** Behaviour found by reading git's source: with `-U0` git trims the common tail in 1 KiB blocks before diffing, which can move where a change lands; hunk headers are cut at the first byte sequence git does not accept as UTF-8; `--ignore-blank-lines` counts a final one-byte line as blank; conflict markers take CRLF line endings from the lines around them. hunks does all of it.

On the same real files, string input is checked against git's output too, `diff()` is checked to rebuild exactly into `patch()`'s text, and `edits()` to turn every old file into the new one. The test suite repeats the comparisons against whichever git is installed, so parity can be re-checked on any machine. The real releases are listed in `scripts/releases.txt`; `node scripts/fetch-corpus.ts corpus` downloads them, and `node scripts/corpus.ts corpus` and `node scripts/merge-corpus.ts corpus --git-merge` repeat the checks. In `bench/`, `node jsdiff-compare.ts ../corpus` and `node merge-compare.ts ../corpus` repeat the comparisons with other libraries. hunks follows current git; see [Compatibility](#compatibility) for the details that changed after git 2.43.

## API

### `patch(oldText, newText, options?)`

A unified diff, exactly what `git diff --no-index` prints below its header lines. Empty when the inputs are equal.

```js
patch('a\nb\n', 'a\nc\n', { fromFile: 'a/notes.txt', toFile: 'b/notes.txt' });
// --- a/notes.txt
// +++ b/notes.txt
// @@ -1,2 +1,2 @@
//  a
// -b
// +c
```

Strings in, string out. Pass `Uint8Array`s to work on raw bytes and get bytes back; then even files that are not valid UTF-8 come out exactly as git prints them. If only one side is bytes, the other is taken as UTF-8 and the result is bytes.

The labels are quoted the way git quotes paths: `café.txt` becomes `"a/caf\303\251.txt"`, and a name containing a line break cannot add lines to the patch. To print a name some other way, leave the labels out and write the two lines yourself.

### `diff(oldText, newText, options?)`

The same hunks as structured data, for rendering. Bytes are compared exactly, as `patch()` compares them, so the hunks are always git's; the `text` of each line is then decoded as UTF-8, with U+FFFD standing in for invalid bytes.

```js
const { hunks, added, removed } = diff(before, after, { inline: true });

for (const hunk of hunks) {
  hunk.header;   // '@@ -10,6 +10,10 @@ export function cacheKey(url: string) {'
  hunk.heading;  // 'export function cacheKey(url: string) {'
  for (const line of hunk.lines) {
    line.type;       // 'context' | 'removed' | 'added'
    line.text;       // without the line break
    line.oldNumber;  // 1-based, or null for added lines
    line.newNumber;  // 1-based, or null for removed lines
    line.newline;    // false for a last line without a line break
    line.spans;      // with inline: true, the changed parts: [[start, end], ...]
  }
}
```

With `inline: true`, removed and added lines carry `spans`: the parts that changed, as `[start, end)` offsets into `text`. They come from diffing the words of a whole block of removed lines against the block of added lines, so lines pair up correctly even when they were split, joined or reordered. A line that is new, or too different from anything on the other side for highlighting to help, gets no spans; so does every line of a block too large to read word by word (over 50,000 words and symbols).

`text` is the file's own content. Escape it before you put it into HTML or write it to a terminal.

### `merge(ours, base, theirs, options?)`

A three-way merge of two texts edited from a common base, byte for byte what `git merge-file -p ours base theirs` prints. Changes that do not overlap are taken from both sides; overlapping changes become conflicts, shrunk to the lines that really differ.

```js
const base   = 'host = "localhost"\nport = 8080\nretries = 3\n';
const ours   = 'host = "example.com"\nport = 8080\nretries = 5\n';
const theirs = 'host = "localhost"\nport = 8080\nretries = 4\n';

const { merged, conflicts } = merge(ours, base, theirs, { labels: { ours: 'mine', theirs: 'theirs' } });
// conflicts: 1
// merged:
//   host = "example.com"
//   port = 8080
//   <<<<<<< mine
//   retries = 5
//   =======
//   retries = 4
//   >>>>>>> theirs
```

Our new host merges cleanly; both sides changed `retries`, so that line is a conflict. As in git, changes to adjacent lines conflict too: two changes merge cleanly only with at least one unchanged line between them.

`conflicts` is how many conflicts `merged` holds; 0 means the merge is clean. As with `patch()`, strings in give a string out and `Uint8Array`s give bytes. The order of the arguments is that of `git merge-file`: ours, the base, theirs.

| option | git | default |
| --- | --- | --- |
| `style` | `--diff3`, `--zdiff3`, `merge.conflictStyle` | `'merge'`; `'diff3'` also shows the base, `'zdiff3'` shows it after moving shared lines out of the conflict |
| `favor` | `--ours`, `--theirs`, `--union` | none; settles every conflict with one side, or with both |
| `level` | | `'zealous-alnum'`, as `git merge-file`; `git merge` uses `'zealous'`; also `'eager'`, `'minimal'` |
| `algorithm` | `--diff-algorithm`, `-Xdiff-algorithm` | `'myers'`, as `git merge-file`; `git merge` uses `'histogram'` |
| `ignoreWhitespace` and the other whitespace options | `-Xignore-all-space` and so on | `false` |
| `markerSize` | `--marker-size` | `7` |
| `labels` | `-L` | none: `{ ours, base, theirs }`, the names after the markers |
| `timeout` | | none |

For the content merge of `git merge`, pass `{ algorithm: 'histogram', level: 'zealous' }`, with `labels` such as `{ ours: 'HEAD', theirs: 'feature' }`.

### `edits(oldText, newText, options?)`

The raw edit script: 0-based, end-exclusive line ranges, ready for `slice()`.

```js
edits('a\nb\nc\n', 'a\nx\nc\nd\n');
// [ { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 },
//   { oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 4 } ]
```

### `diffArrays(oldItems, newItems, options?)`

The same engine for any two arrays, or two typed arrays. Elements are compared the way a `Map` compares keys (`===`, except that `NaN` matches `NaN`), or through `key`.

```js
diffArrays(oldRows, newRows, { key: (row) => row.id, algorithm: 'histogram' });
```

### `inline(removedLines, addedLines, options?)`

The word-level highlighting on its own, for when you have your own line diff: `{ removed, added }`, the spans of every line. Takes `timeout`.

### Options

Every option but `timeout` maps to a `git diff` flag.

| option | git | default |
| --- | --- | --- |
| `algorithm` | `--diff-algorithm` | `'myers'`; also `'minimal'`, `'patience'`, `'histogram'` |
| `indentHeuristic` | `--[no-]indent-heuristic` | `true` |
| `context` | `-U` | `3` |
| `interHunkContext` | `--inter-hunk-context` | `0` |
| `functionContext` | `-W` | `false` |
| `ignoreWhitespace` | `-w` | `false` |
| `ignoreWhitespaceChange` | `-b` | `false` |
| `ignoreWhitespaceAtEol` | `--ignore-space-at-eol` | `false` |
| `ignoreCrAtEol` | `--ignore-cr-at-eol` | `false` |
| `ignoreBlankLines` | `--ignore-blank-lines` | `false` |
| `ignoreMatchingLines` | `-I` | none; a `RegExp` or an array of them |
| `anchored` | `--anchored` | none; a string or an array; implies patience |
| `funcname` | `diff.<driver>.xfuncname` | git's default: the nearest line above that starts with a letter, `_` or `$`. A `RegExp` (first capture group, else the match), a function `(line) => string \| null`, or `false` |
| `timeout` | | none; milliseconds, after which a `DiffTimeoutError` is thrown |

`patch` also takes `fromFile` and `toFile` for the `---` and `+++` lines; `diff` takes `inline`.

Which algorithm? `myers` is git's default and what people are used to seeing. `histogram` is much faster on large rewrites (see the benchmarks) and often clearer on code; it is what we would pick for a code review tool. Its worst case is quadratic, in git as here, so give it a `timeout` when the input comes from strangers.

## Command line

Installed, the command is `hunks`; with npx, use the package name.

```sh
npx @thetusharkhemka/hunks old.ts new.ts
npx @thetusharkhemka/hunks --histogram -U5 -w before.json after.json
```

The flags are git's, bundles like `-wU1` included. Piped or redirected, the output is exactly that of `git diff --no-index`, header lines and all: blob ids, modes, quoted paths, symbolic links, standard input as `-`, pipes such as `<(command)`, binary files, `/dev/null`, files over 512 MiB shown as binary. So is the exit code: 1 when the files differ, 0 when they do not. Every error exits with 2; git exits with 1 for a missing file, the same as for files that differ, and with 128 or 129 for other errors. `--quiet` prints nothing and only sets the exit code.

On a terminal, hunks colours its output and highlights changed words and whitespace errors. Control characters and invisible Unicode in the files are shown as escapes, `^[` or `<U+202E>`, so a file can neither drive your terminal nor hide text from you.

`hunks merge-file` merges three files as `git merge-file` does, writing the result into the first file, or to standard output with `-p`. It takes git's options (`--diff3`, `--zdiff3`, `--ours`, `--theirs`, `--union`, `--marker-size`, `--diff-algorithm`, `-L`) and exits as git does: with the number of conflicts, up to 127, or 255 on an error.

```sh
npx @thetusharkhemka/hunks merge-file -p --zdiff3 mine.ts base.ts theirs.ts
```

hunks compares two files; unlike git, it does not walk directories. `hunks --help` and `hunks merge-file --help` list everything. A file named `merge-file` is compared as `./merge-file`.

## Security

hunks is built to run on input you do not control.

- **Time.** Every function takes `timeout` and throws `DiffTimeoutError` when it runs out. Myers and patience grow only a little faster than their input; histogram and minimal can be driven to quadratic time by crafted input, in git as here.
- **Size.** Up to 512 MiB a side. Larger input is refused before any work starts.
- **Patches and merges.** Patch labels are quoted as git quotes paths, a custom `funcname` cannot break the header line, and a merge label cannot contain a line break, so no name can forge lines of the output.
- **Terminals.** The CLI shows control characters, bidirectional overrides (the trick behind Trojan Source), zero-width characters and Unicode tags as escapes before they reach your terminal. Piped output stays git's bytes.
- **Supply chain.** No runtime dependencies and no install scripts. `scripts/verify-release.ts` rebuilds a version and compares it with the registry's tarball, file by file.

What is left to you, and how to report a vulnerability: [SECURITY.md](./SECURITY.md).

## Benchmarks

Median time per diff, in a fresh process per measurement. Files are real: the same file in two consecutive releases of the package.

| | hunks | hunks histogram | diff (jsdiff) | @jest/diff-sequences | fast-myers-diff | diff-match-patch | vscode-diff | @vscode/diff |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| express response.js, 1,180 lines | 1.8 ms | 1.5 ms | 3.9 ms | 1.0 ms | 3.3 ms | 1.8 ms | 12 ms | 13 ms |
| lodash.js, 17,162 lines, one fix | 7.1 ms | 7.3 ms | 9.5 ms | 9.7 ms | 8.4 ms | 10 ms | 14 ms | 13 ms |
| jquery.js, 10,882 lines | 6.4 ms | 5.4 ms | 241 ms | 35 ms | 40 ms | 33 ms | 296 ms | 294 ms |
| react-dom client, 24,717 lines, rewritten | 114 ms | 16 ms | 8.5 s | 742 ms | 941 ms | 964 ms | 10.8 s | 11.2 s |
| three.js WebGPU build, 63,634 lines | 54 ms | 33 ms | 5.8 s | 560 ms | 669 ms | 587 ms | 1.5 s | 1.6 s |

hunks' times include producing the full unified patch. @jest/diff-sequences, fast-myers-diff and diff-match-patch only compute an edit script, and the two VS Code libraries also refine changes down to characters, so this is not like for like; it is what you get from each. @vscode/diff was measured with its TypeScript backend, since its WebAssembly one panics in version 0.0.2-0. Node 22.23, Intel Xeon at 2.1 GHz. To reproduce: `cd bench && npm install --ignore-scripts && node bench.ts`.

Merging the 968 real cases from [Why](#why) the way `git merge` does (histogram) takes hunks 2.8 s in all; node-diff3 takes 3.2 s, and diff3 24 s.

## Compatibility

- **git versions.** hunks follows current git. A few details changed after git 2.43, all in uncommon situations: `--minimal` stopped setting aside lines that occur very often (2.50); `--anchored` stopped combining with `--minimal` (2.53); histogram re-diffs blocks that were merged while sliding (2.54); `--anchored` tests the anchor against the new side's line (2.54); and an empty merge label no longer leaves a space after its marker (2.55). The test suite checks both behaviours against whichever git it finds. Before 2.50, `git merge` used histogram whatever `-Xdiff-algorithm` said.
- **Merges.** hunks reads no git configuration: pass `style` where git would read `merge.conflictStyle`. Like git, it never applies the indent heuristic when merging.
- **Text and bytes.** Strings are compared as UTF-16 text and headers are cut on UTF-8 byte counts, as git does. For byte-exact output on input that is not valid UTF-8, pass `Uint8Array`s. Options written as text (`anchored`, `ignoreMatchingLines`, `funcname`) behave the same either way.
- **Size.** Up to 512 MiB a side: the longest string V8 can hold, and where git stops diffing files as text. The CLI shows larger files as binary, as git does.
- **Function names.** The default rule is git's. git's language-specific patterns come from attributes in a repository; pass `funcname` a `RegExp` for the same effect.
- **Index lines.** The CLI abbreviates blob ids to 7 characters, as git does outside a repository. Inside a large repository git may use more.
- **Runtimes.** Node 20 and later, Bun, Deno and current browsers. The package is ESM; `require()` works in Node 20.19+ and 22.12+.

Not covered: comparing directories, rename and copy detection, `--color-moved`, `--word-diff` output, binary patches, applying patches, and merging binary files.

## Credits

The ideas are other people's. Eugene W. Myers, *An O(ND) Difference Algorithm and Its Variations* (1986). Davide Libenzi's LibXDiff, which became git's xdiff, with the three-way merge by Johannes Schindelin, and the git contributors who have improved it since, among them Elijah Newren's zdiff3. Michael Haggerty's indent heuristic. Bram Cohen's patience diff. Histogram diff from JGit, by Shawn Pearce and others.

hunks is an independent implementation in TypeScript. git's source was the reference for its behaviour and the git binary is the oracle in its tests; no git code is included. The histogram implementation follows JGit's design, which is available under the Eclipse Distribution License; see [NOTICE](./NOTICE).

## License

MIT
