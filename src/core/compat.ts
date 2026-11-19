/**
 * Which git release to imitate, as major * 100 + minor (2.43 -> 243).
 *
 * The default is current git. Three details of git's output changed after
 * 2.43, and the parity tests set this to the version of the git binary they
 * compare against:
 *
 *   2.50  --minimal no longer discards lines that match very often
 *   2.54  histogram re-diffs change groups merged during compaction
 *   2.54  --anchored tests the line on the new side, not the old one
 *
 * Not part of the public API.
 */
export const compat = { git: Infinity };
