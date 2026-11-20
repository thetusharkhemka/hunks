# Security

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab,
**Report a vulnerability**. Please do not open a public issue. A fix for a
confirmed problem is released before the details are made public, and the
advisory credits you unless you prefer otherwise.

Fixes go into the latest minor release.

## What hunks guarantees

**The package runs nothing on install and has no runtime dependencies.**
The library touches neither the file system nor the network; the CLI reads
the two files it compares, and its own package.json for `--version`.

**Bounded work on hostile input.** Each side may be up to 512 MiB, the
longest string V8 can hold and the size at which git stops diffing files
as text. Larger input is refused with a `RangeError` before any work
starts. Myers (the default) and patience grow only a little faster than
the input: on the worst inputs we could construct, ten times the lines
took fifteen to twenty times as long. Histogram and minimal can take
quadratic time on input crafted for it, as they do in git. Since any
algorithm takes a while on hundreds of megabytes, pass `timeout` whenever
the input is untrusted: every function accepts it, and it throws
`DiffTimeoutError` once the time is up. Word highlighting has a fixed
budget of 50,000 tokens per block and stops counting as soon as it runs
out.

**Patches cannot be forged through their labels.** `fromFile` and `toFile`
are quoted as git quotes paths, so a name containing a line break, a quote
or an escape character stays on its own line. A custom `funcname` cannot
break the hunk header line either.

**The CLI is safe to point at a terminal.** Control characters in the files
are shown in caret notation (`^[`), and code points that are invisible or
reorder text are shown as `<U+202E>`. That covers the bidirectional
overrides of Trojan Source attacks, zero-width characters, Unicode tags
used to hide instructions, and stray byte order marks. A file cannot move
the cursor, write to the clipboard or retitle the window, and two lines
that differ only in invisible characters no longer look the same. Letters
that merely look alike, such as a Cyrillic а and a Latin a, are shown as
they are. Error messages are escaped the same way.
Piped or redirected output is git's bytes, unchanged, so that it can go
into `git apply`.

## What it leaves to you

- `Line.text` and the other fields of `diff()` are the files' contents.
  Escape them before putting them into HTML or a terminal.
- Patterns you pass as `ignoreMatchingLines` or `funcname` run on lines
  of the input, and no timeout can interrupt a regular expression. On
  untrusted input, use patterns without nested repetition.
- Patch content lines are the files' lines, exactly as git writes them.
  A line can contain a carriage return or a vertical tab, and a patch
  parser that also splits lines on those will see more lines than git
  does.

## Verifying a release

Every version on npm is signed by the registry, and versions released
through this repository's workflow also carry a provenance attestation
that names the commit and the workflow run that built them:

    npm audit signatures

To check that a published tarball is exactly what the source builds, check
out its tag and run:

    npm ci --ignore-scripts
    node scripts/verify-release.ts

It rebuilds and packs the checkout and compares the result with the
registry's tarball, file by file, without running anything from it.
