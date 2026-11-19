/**
 * State shared by the algorithms during one diff: scratch arrays sized once
 * per diff instead of once per recursion step, and the time limit.
 */

/** Thrown when a call runs past its `timeout`. */
export class DiffTimeoutError extends Error {
  /** The limit that was exceeded, in milliseconds. */
  readonly timeout: number;

  constructor(timeout: number) {
    super(`hunks: gave up after ${timeout} ms (the timeout option)`);
    this.name = 'DiffTimeoutError';
    this.timeout = timeout;
  }
}

const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();

/** The time limit of one call, shared by every stage of it. */
export class Deadline {
  readonly timeout: number;
  private readonly at: number;

  constructor(timeout: number) {
    this.timeout = timeout;
    this.at = timeout === Infinity ? Infinity : now() + timeout;
  }

  /** Throw if the limit has passed. Cheap when there is none. */
  check(): void {
    if (this.at !== Infinity && now() > this.at) throw new DiffTimeoutError(this.timeout);
  }
}

export const NO_DEADLINE = new Deadline(Infinity);

export class Env {
  /** Occurrence counts per class, for Myers' discard pass. Kept zeroed. */
  readonly count1: Int32Array;
  readonly count2: Int32Array;
  /** git before 2.50 discarded frequent lines even when asked to be minimal. */
  readonly minimalDiscards: boolean;

  private readonly classes: number;
  private readonly deadline: Deadline;

  // Histogram's occurrence index, reused by every call. An entry belongs to
  // the current call when its stamp equals `generation`.
  histPtr: Int32Array | null = null;
  histCnt: Int32Array | null = null;
  histStamp: Int32Array | null = null;
  histNext: Int32Array | null = null;
  generation = 0;

  constructor(classes: number, options: { minimalDiscards?: boolean; deadline?: Deadline } = {}) {
    this.classes = classes;
    this.count1 = new Int32Array(classes);
    this.count2 = new Int32Array(classes);
    this.minimalDiscards = !!options.minimalDiscards;
    this.deadline = options.deadline ?? NO_DEADLINE;
  }

  check(): void {
    this.deadline.check();
  }

  /** Make sure the histogram index can hold lines 1..lines. */
  histogramIndex(lines: number): void {
    if (this.histPtr === null) {
      this.histPtr = new Int32Array(this.classes);
      this.histCnt = new Int32Array(this.classes);
      this.histStamp = new Int32Array(this.classes);
    }
    if (this.histNext === null || this.histNext.length < lines + 1) this.histNext = new Int32Array(lines + 1);
  }
}
