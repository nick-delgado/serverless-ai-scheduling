/**
 * A `Transcriber` with no audio (S6-01, #28). The dev server on the Cognito mock uses it in place of
 * the browser's mic prompt (`TranscriberContext.ts`, #29), and the tests configure it through its constructor (or `options`, which a test can
 * change between recordings, e.g. to grant permission on the second tap).
 */
import {
  type Transcriber,
  type TranscriberCallbacks,
  TranscriberError,
  type TranscriberSession,
} from "./transcriber";

export const SAMPLE_TRANSCRIPT = "I'd like to book a check-up next week.";

export interface MockTranscriberOptions {
  /** The final transcript `stop()` resolves with. Default `SAMPLE_TRANSCRIPT`. */
  transcript?: string;
  /** Delay before `start()` settles, like a permission prompt. Default 0. */
  startDelayMs?: number;
  /** Delay between `stop()` and the final transcript. Default 0. */
  delayMs?: number;
  /** `stop()` never settles: no final transcript arrives. */
  neverFinal?: boolean;
  /** `start()` rejects with `denied`. */
  denied?: boolean;
  /** `start()` rejects with `unavailable`. */
  unavailable?: boolean;
  /** Fail with `failed`: `start()` rejects, `onError` fires while recording, or `stop()` rejects. */
  error?: "start" | "recording" | "stop";
  /** Time after `start()` resolves at which `error: "recording"` fires. Default 0. */
  errorAfterMs?: number;
  /** How often `onLevel` reports while recording. Default 100 ms. */
  levelIntervalMs?: number;
}

export type MockSessionState = "recording" | "stopped" | "cancelled";

/** One recording, as a test sees it. */
export interface MockSessionRecord {
  state: MockSessionState;
}

/** Levels the mock cycles through, so the indicator moves without randomness. */
export const MOCK_LEVELS = [0.2, 0.6, 0.9, 0.5, 0.3] as const;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MockTranscriber implements Transcriber {
  options: MockTranscriberOptions;
  /** Every session `start()` resolved with, oldest first. */
  readonly sessions: MockSessionRecord[] = [];
  /** How many times `start()` was called. */
  starts = 0;

  constructor(options: MockTranscriberOptions = {}) {
    this.options = options;
  }

  async start(callbacks: TranscriberCallbacks = {}): Promise<TranscriberSession> {
    this.starts += 1;
    const options = { ...this.options };
    if (options.startDelayMs) await wait(options.startDelayMs);
    if (options.denied) throw new TranscriberError("denied");
    if (options.unavailable) throw new TranscriberError("unavailable");
    if (options.error === "start") throw new TranscriberError("failed");

    const record: MockSessionRecord = { state: "recording" };
    this.sessions.push(record);

    let tick = 0;
    const levels = setInterval(() => {
      callbacks.onLevel?.(MOCK_LEVELS[tick % MOCK_LEVELS.length] ?? 0);
      tick += 1;
    }, options.levelIntervalMs ?? 100);
    const failure =
      options.error === "recording"
        ? setTimeout(() => {
            clearInterval(levels);
            callbacks.onError?.(new TranscriberError("failed"));
          }, options.errorAfterMs ?? 0)
        : undefined;
    const release = () => {
      clearInterval(levels);
      clearTimeout(failure);
    };

    return {
      stop: async () => {
        record.state = "stopped";
        release();
        if (options.neverFinal) return new Promise<string>(() => undefined);
        if (options.delayMs) await wait(options.delayMs);
        if (options.error === "stop") throw new TranscriberError("failed");
        return options.transcript ?? SAMPLE_TRANSCRIPT;
      },
      cancel: () => {
        record.state = "cancelled";
        release();
      },
    };
  }
}
