# Changelog

## 1.2.0

Three-way merging, and hardening for input you do not control. Every
change is covered by the test suite, and checked against git wherever git
defines the behaviour.

Merging, new
- `merge(ours, base, theirs, options)`: git's three-way merge, byte for
  byte what `git merge-file` prints; with `{ algorithm: 'histogram',
  level: 'zealous' }`, the content merge of `git merge`. Conflict styles
  `merge`, `diff3` and `zdiff3`; conflicts settled for `ours`, `theirs` or
  their `union`; marker size and labels; every diff algorithm and
  whitespace option. Checked against `git merge-file`, `git merge-tree`
  and `git merge` on 34,220 merges of real files, from three consecutive
  releases of 20 projects, and on 33,000 generated merges.
- `hunks merge-file`: the same on the command line, with the options and
  exit codes of `git merge-file`.

Library
- `timeout` on every function: milliseconds, then a `DiffTimeoutError`.
  One deadline covers the whole call, word highlighting included.
- Histogram is as fast as git on input crafted to make it quadratic: 8.0 s
  against git's 8.7 s on 50,000 swapped line pairs. Before, it took over a
  minute. On real files it is 1.6 to 2 times as fast as in 1.1.0.
- `fromFile` and `toFile` are quoted as git quotes paths. Before, a name
  containing a line break could add lines to the patch. Names with
  non-ASCII characters now print as git prints them (`"a/caf\303\251.txt"`),
  and a name with a space gets git's trailing tab.
- A custom `funcname` can no longer break the hunk header line.
- `diff()` compares `Uint8Array` input byte for byte, as `patch()` does,
  and decodes only the text of each line. Before, it decoded first, which
  hid an added or removed byte order mark, and any change from one invalid
  byte to another.
- A byte order mark is kept wherever text is decoded. This fixes the `-U0`
  tail cut and hunk headings that begin with one.
- Word highlighting stops counting as soon as a block is over its budget,
  keeps spans right for lines that contain a line break, and no longer
  marks the CR of a CRLF line ending as changed when it is not.
- More than 512 MiB on a side is refused with a `RangeError` before any
  work; options that are not objects throw a `TypeError`.
- With `algorithm: 'minimal'` and `anchored`, the diff follows git 2.53:
  the anchors switch to patience and leave minimal behind.
- `Uint8Array`s and `RegExp`s made in another realm, such as Jest's
  sandbox, are accepted. `ignoreMatchingLines` and `anchored` must hold
  RegExps and strings, and an `ArrayBuffer` passed as text gets an error
  that says how to wrap it. `diffArrays` takes typed arrays and checks its
  arguments; `inline` takes `timeout` and checks its arguments.

Command line
- Algorithm flags apply in order, as in git: `--anchored` switches to
  patience, a later `--histogram` or `--diff-algorithm` switches away and
  leaves the anchors unused, and `--patience` drops anchors given before
  it. Before, any `--anchored` forced patience.
- On a terminal, control characters, bidirectional overrides, zero-width
  characters and Unicode tags in the files are shown as escapes (`^[`,
  `<U+202E>`), so a file can neither drive the terminal nor hide text.
  Error messages are escaped too. Piped output is unchanged.
- Pipes are read as git 2.42 and later read them: `hunks <(a) <(b)`
  compares the outputs. Before, on Linux, it compared the names of the
  pipes.
- Devices and sockets are refused instead of read forever. Files over
  512 MiB show as binary, as in git, and standard input and pipes stop at
  512 MiB.
- The `index` line appears only when the blob ids differ, as in git, so no
  longer for standard input against `/dev/null`.
- Whitespace errors are found in linear time; in 1.1.0 a line of 80,000
  spaces took 3.7 s. Spaces before a tab in the indentation are marked,
  as git marks them.
- When the reader stops early, as `head` does, hunks exits quietly with
  status 141, as git does, instead of printing a stack trace.
- Colour by default follows Node's view of the terminal: `NO_COLOR`,
  `TERM=dumb` and `FORCE_COLOR=0` turn it off. It never goes into a pipe
  unless `--color=always` asks for it.

Supply chain
- A release workflow publishes through npm trusted publishing, with
  provenance and a required approval; RELEASING.md lists the settings.
- Actions are pinned to commit SHAs and workflows start without token
  permissions. CodeQL and OpenSSF Scorecard run on every push. Dependabot
  waits a week before it proposes an update.
- `scripts/verify-release.ts` rebuilds a version and compares it with the
  registry's tarball, file by file. 1.0.0 is identical to what its tag
  builds.
- SECURITY.md: what hunks guarantees, what it leaves to the caller, and
  how to report a vulnerability.

## 1.1.0

Tagged, but never published to npm; these changes reach npm in 1.2.0.

Found in a full review after 1.0.0. Every change below is checked against
git in the test suite.

Library
- Byte input (`Uint8Array`): `anchored`, `ignoreMatchingLines` and custom
  `funcname` now behave as with strings when they contain non-ASCII text.
  Before, they were compared with raw bytes and never matched.
- `patch()` and `edits()` accept a string on one side and bytes on the
  other; the string is taken as UTF-8.
- `diff()` accepts `Uint8Array` input and reads it as UTF-8.
- Inputs that are neither strings nor `Uint8Array`s, and invalid `funcname`
  values, now throw a `TypeError` instead of failing obscurely.

Command line
- Symbolic links are compared by their targets (mode 120000), and a file
  that became a link, or the reverse, is shown as a deletion and a creation,
  as git does. Before, links were followed.
- Standard input shows a zero blob id in the `index` line, and `- -`
  compares equal, as with git.
- git's option syntax: `--unified` with an optional attached value, bundled
  short options such as `-wU1`, case-insensitive `--diff-algorithm`.
- New `--quiet`; `-p`, `-u`, `--patch`, `--exit-code`, `--no-index` and
  `--no-ext-diff` are accepted.
- Clearer messages for missing files, directories and invalid patterns.

## 1.0.0

First release.

- `patch()`: unified diffs byte-identical to `git diff`, for strings or bytes.
- `diff()`: the same hunks as structured data, with optional word-level spans.
- `edits()` and `diffArrays()`: the edit script, for lines or any sequence.
- `inline()`: word-level highlighting for a block of changed lines.
- Myers with git's discard pass and cost limits, `minimal`, `patience` and
  `histogram`; slider compaction with the indent heuristic; every whitespace
  option; `--ignore-blank-lines`, `-I`, `--anchored`, `-W`, `-U0` tail trimming.
- `hunks` CLI: `git diff --no-index` output, header lines and exit codes
  included, plus word highlighting in colour.
- Verified byte for byte against the git binary on 634 real file changes under
  11 option sets and on 50,000 generated cases.
