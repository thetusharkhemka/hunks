/**
 * Slider compaction.
 *
 * A block of added or deleted lines is often free to move: if the first line
 * of the block equals the line after it, the block can slide down by one, and
 * the diff is just as correct. Which position is chosen decides whether a
 * reviewer reads "added a function" or "added the tail of one function and
 * the head of another".
 *
 * This pass first slides every block as far as it goes, merging it with
 * neighbouring blocks and aligning it with changes on the other side when it
 * can. Blocks that are still free to move are then placed by the indent
 * heuristic: Michael Haggerty's scoring of split points by indentation and
 * blank lines, whose weights were fitted to a corpus of hand-rated diffs.
 * See git commit 433860f ("diff: improve positioning of add/delete blocks").
 */

import type { Side } from './lines.ts';
import type { Env } from './env.ts';
import { myers } from './myers.ts';

const MAX_INDENT = 200;
const MAX_BLANKS = 20;
const INDENT_HEURISTIC_MAX_SLIDING = 100;

const START_OF_FILE_PENALTY = 1;
const END_OF_FILE_PENALTY = 21;
const TOTAL_BLANK_WEIGHT = -30;
const POST_BLANK_WEIGHT = 6;
const RELATIVE_INDENT_PENALTY = -4;
const RELATIVE_INDENT_WITH_BLANK_PENALTY = 10;
const RELATIVE_OUTDENT_PENALTY = 24;
const RELATIVE_OUTDENT_WITH_BLANK_PENALTY = 17;
const RELATIVE_DEDENT_PENALTY = 23;
const RELATIVE_DEDENT_WITH_BLANK_PENALTY = 17;
const INDENT_WEIGHT = 60;

export interface CompactOptions {
  indentHeuristic: boolean;
  /** Re-diff merged groups (git >= 2.54, histogram only). */
  rediff: boolean;
  needMin: boolean;
  env: Env;
}

/**
 * A run of changed records [start, end). An empty group (start === end) sits
 * just above record `start`. Every unchanged record is followed by a group,
 * so the groups of the two sides pair up one to one.
 */
class Group {
  start = 0;
  end = 0;
  private readonly side: Side;
  private readonly changed: Uint8Array;

  constructor(side: Side, changed: Uint8Array) {
    this.side = side;
    this.changed = changed;
    while (changed[this.end + 1]) this.end++;
  }

  next(): boolean {
    if (this.end === this.side.n) return false;
    this.start = this.end + 1;
    this.end = this.start;
    while (this.changed[this.end + 1]) this.end++;
    return true;
  }

  previous(): boolean {
    if (this.start === 0) return false;
    this.end = this.start - 1;
    this.start = this.end;
    while (this.changed[this.start]) this.start--;
    return true;
  }

  slideDown(): boolean {
    const { ids, n } = this.side;
    if (this.end < n && ids[this.start] === ids[this.end]) {
      this.changed[this.start++ + 1] = 0;
      this.changed[this.end++ + 1] = 1;
      while (this.changed[this.end + 1]) this.end++;
      return true;
    }
    return false;
  }

  slideUp(): boolean {
    const ids = this.side.ids;
    if (this.start > 0 && ids[this.start - 1] === ids[this.end - 1]) {
      this.changed[--this.start + 1] = 1;
      this.changed[--this.end + 1] = 0;
      while (this.changed[this.start]) this.start--;
      return true;
    }
    return false;
  }
}

function broken(what: string): never {
  throw new Error(`hunks: internal error (${what})`);
}

/** Compact the groups of `x`, keeping `y` (the other side) in step. */
export function compact(x: Side, cx: Uint8Array, y: Side, cy: Uint8Array, opts: CompactOptions): void {
  const g = new Group(x, cx);
  const go = new Group(y, cy);
  const indents = new Int16Array(x.n).fill(-2);
  const indent = (i: number): number => {
    let v = indents[i];
    if (v === -2) indents[i] = v = measureIndent(x, i);
    return v;
  };

  for (;;) {
    if (g.end !== g.start) {
      const origStart = g.start;
      const origEnd = g.end;
      let groupSize: number;
      let earliestEnd: number;
      let endMatchingOther: number;

      // Slide up and down as far as possible, absorbing any group we bump
      // into, until the group stops growing.
      do {
        groupSize = g.end - g.start;
        endMatchingOther = -1;

        while (g.slideUp()) {
          if (!go.previous()) broken('group sync broken sliding up');
        }
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;

        for (;;) {
          if (!g.slideDown()) break;
          if (!go.next()) broken('group sync broken sliding down');
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupSize !== g.end - g.start);

      // The group now sits as low as it can go.
      if (g.end === earliestEnd) {
        // It cannot move at all.
      } else if (endMatchingOther !== -1) {
        // Line up with the nearest change on the other side, so that one
        // change is not split into a separate deletion and insertion.
        while (go.end === go.start) {
          if (!g.slideUp()) broken('match disappeared');
          if (!go.previous()) broken('group sync broken sliding to match');
        }
      } else if (opts.indentHeuristic) {
        let shift = earliestEnd;
        if (g.end - groupSize - 1 > shift) shift = g.end - groupSize - 1;
        if (g.end - INDENT_HEURISTIC_MAX_SLIDING > shift) shift = g.end - INDENT_HEURISTIC_MAX_SLIDING;

        let bestShift = -1;
        let bestIndent = 0;
        let bestPenalty = 0;
        for (; shift <= g.end; shift++) {
          score.effectiveIndent = 0;
          score.penalty = 0;
          addSplitScore(x, shift, indent);
          addSplitScore(x, shift - groupSize, indent);
          const cmp = INDENT_WEIGHT * Math.sign(score.effectiveIndent - bestIndent) + (score.penalty - bestPenalty);
          if (bestShift === -1 || cmp <= 0) {
            bestIndent = score.effectiveIndent;
            bestPenalty = score.penalty;
            bestShift = shift;
          }
        }

        while (g.end > bestShift) {
          if (!g.slideUp()) broken('best shift unreached');
          if (!go.previous()) broken('group sync broken sliding to blank line');
        }
      }

      // Merging groups can create a combined group in which some lines now
      // match the other side after all. git re-diffs those, for histogram
      // only (its LCS is the one that can leave such matches behind).
      if (opts.rediff && go.end !== go.start && (g.start !== origStart || g.end !== origEnd)) {
        for (let i = g.start; i < g.end; i++) cx[i + 1] = 0;
        for (let i = go.start; i < go.end; i++) cy[i + 1] = 0;
        myers(x, y, cx, cy, g.start, g.end - g.start, go.start, go.end - go.start, opts.needMin, opts.env);
      }
    }

    if (!g.next()) break;
    if (!go.next()) broken('group sync broken moving to next group');
  }

  if (go.next()) broken('group sync broken at end of file');
}

/**
 * Columns of indentation, a tab advancing to the next multiple of 8;
 * -1 for a blank line. Capped so that binary junk cannot blow up the cost.
 */
function measureIndent(side: Side, i: number): number {
  const text = side.text;
  const end = side.starts[i + 1];
  let ret = 0;
  for (let k = side.starts[i]; k < end; k++) {
    const c = text.charCodeAt(k);
    if (c === 32) ret += 1;
    else if (c === 9) ret += 8 - (ret % 8);
    else if (c !== 10 && c !== 13) return ret;
    if (ret >= MAX_INDENT) return MAX_INDENT;
  }
  return -1;
}

const score = { effectiveIndent: 0, penalty: 0 };

/**
 * Score a hypothetical split of `side` just above record `split`; lower is
 * better. Adds into the shared `score` accumulator.
 */
function addSplitScore(side: Side, split: number, indent: (i: number) => number): void {
  const n = side.n;
  const endOfFile = split >= n;
  const lineIndent = endOfFile ? -1 : indent(split);

  let preBlank = 0;
  let preIndent = -1;
  for (let i = split - 1; i >= 0; i--) {
    preIndent = indent(i);
    if (preIndent !== -1) break;
    preBlank++;
    if (preBlank === MAX_BLANKS) {
      preIndent = 0;
      break;
    }
  }

  let postBlankAfter = 0;
  let postIndent = -1;
  for (let i = split + 1; i < n; i++) {
    postIndent = indent(i);
    if (postIndent !== -1) break;
    postBlankAfter++;
    if (postBlankAfter === MAX_BLANKS) {
      postIndent = 0;
      break;
    }
  }

  if (preIndent === -1 && preBlank === 0) score.penalty += START_OF_FILE_PENALTY;
  if (endOfFile) score.penalty += END_OF_FILE_PENALTY;

  // Blank lines following the split, the line right after it included.
  const postBlank = lineIndent === -1 ? 1 + postBlankAfter : 0;
  const totalBlank = preBlank + postBlank;
  score.penalty += TOTAL_BLANK_WEIGHT * totalBlank;
  score.penalty += POST_BLANK_WEIGHT * postBlank;

  const effective = lineIndent !== -1 ? lineIndent : postIndent;
  const anyBlanks = totalBlank !== 0;
  score.effectiveIndent += effective;

  if (effective === -1 || preIndent === -1) {
    // Nothing to compare against.
  } else if (effective > preIndent) {
    score.penalty += anyBlanks ? RELATIVE_INDENT_WITH_BLANK_PENALTY : RELATIVE_INDENT_PENALTY;
  } else if (effective === preIndent) {
    // Same level as its predecessor.
  } else if (postIndent !== -1 && postIndent > effective) {
    // Less indented than what came before but more follows: likely the
    // start of a new block.
    score.penalty += anyBlanks ? RELATIVE_OUTDENT_WITH_BLANK_PENALTY : RELATIVE_OUTDENT_PENALTY;
  } else {
    // Likely the end of a block.
    score.penalty += anyBlanks ? RELATIVE_DEDENT_WITH_BLANK_PENALTY : RELATIVE_DEDENT_PENALTY;
  }
}
