/**
 * The typewriter (FR-013, ADR-007): reveals streamed text a character at a time at a steady pace,
 * however the network delivers it (a word per event, or the whole reply in one burst).
 *
 * Pacing, per tick of `tickMs`:
 * - the reveal budget grows by `elapsed × rate`, where `rate` is the larger of `baseCps` and
 *   `backlog / catchUpSeconds`. A burst therefore never leaves the text more than about
 *   `catchUpSeconds` behind what has arrived, and a trickle reads at a constant `baseCps`;
 * - whole characters are revealed from the budget; the fraction carries over to the next tick;
 * - the budget is measured from wall time (`now`), so a throttled background tab catches up rather
 *   than falling further behind.
 *
 * `instant` (prefers-reduced-motion) reveals everything as it arrives.
 *
 * `reset(keepChars)` applies a `text_reset`: the received text is cut to its first `keepChars`
 * characters, so anything queued beyond that is dropped, and the revealed text is cut too if it went
 * further. Applying `append` and `reset` in event order matches `visibleText()` in @sched/contracts.
 */

export interface TypewriterOptions {
  /** Called with the revealed text whenever it changes. */
  onUpdate: (text: string) => void;
  /** Called once, after `finish()`, when everything received has been revealed. */
  onComplete?: (text: string) => void;
  /** Reveal immediately instead of typing (prefers-reduced-motion). */
  instant?: boolean;
  baseCps?: number;
  catchUpSeconds?: number;
  tickMs?: number;
  /** Milliseconds; injectable for tests. Defaults to `Date.now`, which Vitest's fake timers control. */
  now?: () => number;
}

/**
 * Steady reading pace when text trickles in: smooth and comfortably readable. Faster streams (the
 * ADR-007 spike measured ~25 events/s, roughly 100+ characters/s) are followed through the catch-up.
 */
export const DEFAULT_BASE_CPS = 60;
/**
 * How far behind the received text the typewriter may fall, in seconds of its current rate. It is
 * also the steady lag behind a stream that arrives faster than `DEFAULT_BASE_CPS`.
 */
export const DEFAULT_CATCH_UP_SECONDS = 0.75;
/** One frame at 60 Hz, rounded. */
export const DEFAULT_TICK_MS = 16;

export class Typewriter {
  #received = "";
  #shown = 0;
  #budget = 0;
  #lastTick = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #finished = false;
  #completed = false;
  #disposed = false;

  readonly #onUpdate: (text: string) => void;
  readonly #onComplete: ((text: string) => void) | undefined;
  readonly #instant: boolean;
  readonly #baseCps: number;
  readonly #catchUpSeconds: number;
  readonly #tickMs: number;
  readonly #now: () => number;

  constructor(options: TypewriterOptions) {
    this.#onUpdate = options.onUpdate;
    this.#onComplete = options.onComplete;
    this.#instant = options.instant ?? false;
    this.#baseCps = options.baseCps ?? DEFAULT_BASE_CPS;
    this.#catchUpSeconds = options.catchUpSeconds ?? DEFAULT_CATCH_UP_SECONDS;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** The text revealed so far. */
  get text(): string {
    return this.#received.slice(0, this.#shown);
  }

  /** Everything received so far (after resets). */
  get received(): string {
    return this.#received;
  }

  append(text: string): void {
    if (this.#disposed || this.#finished) return;
    this.#received += text;
    if (this.#instant) this.#reveal(this.#received.length);
    else this.#schedule();
  }

  reset(keepChars: number): void {
    if (this.#disposed) return;
    this.#received = this.#received.slice(0, keepChars);
    if (this.#shown > this.#received.length) this.#reveal(this.#received.length);
  }

  /** No more text is coming: complete once the rest has been revealed. */
  finish(): void {
    if (this.#disposed) return;
    this.#finished = true;
    this.#maybeComplete();
  }

  /** Stop typing and drop every callback (unmount, an aborted turn). */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    if (this.#timer !== undefined) return; // a run is already under way
    // A fresh run starts its clock now, so idle time between deltas isn't spent as a burst.
    this.#lastTick = this.#now();
    this.#timer = setTimeout(() => this.#tick(), this.#tickMs);
  }

  #tick(): void {
    this.#timer = undefined;
    const now = this.#now();
    // A clock that steps back gives a negative budget and step; `budget -= step` then zeroes it.
    const elapsedSeconds = (now - this.#lastTick) / 1000;
    this.#lastTick = now;
    const backlog = this.#received.length - this.#shown;
    const rate = Math.max(this.#baseCps, backlog / this.#catchUpSeconds);
    this.#budget += elapsedSeconds * rate;
    const step = Math.min(backlog, Math.floor(this.#budget));
    this.#budget -= step;
    if (step > 0) this.#reveal(this.#shown + step);
    if (this.#shown < this.#received.length) {
      this.#timer = setTimeout(() => this.#tick(), this.#tickMs);
    } else {
      // Caught up: budget a late tick didn't need must not become a burst on the next text.
      this.#budget = 0;
      this.#maybeComplete();
    }
  }

  #reveal(length: number): void {
    this.#shown = length;
    this.#onUpdate(this.text);
  }

  #maybeComplete(): void {
    if (!this.#finished || this.#completed) return;
    if (this.#shown < this.#received.length) return;
    this.#completed = true;
    this.#onComplete?.(this.text);
  }
}
