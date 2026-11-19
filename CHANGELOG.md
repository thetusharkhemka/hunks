# Changelog

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
