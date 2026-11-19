# Changelog

## 1.1.0

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
