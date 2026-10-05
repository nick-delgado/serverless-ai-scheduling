/**
 * The voice input seam (S6-01, #28; ADR-006). The recording overlay talks only to a `Transcriber`;
 * it never touches browser audio APIs. #28 ships `MockTranscriber`; #29 implements the real one
 * (AudioWorklet → Amazon Transcribe Streaming) behind the same interface.
 *
 * A `Transcriber` owns mic permission and the audio stream (#28, r1/Q-1 (a)):
 *
 * - `start()` asks for the mic, starts capturing, and resolves with a session once recording has
 *   begun. The overlay starts its m:ss timer and the 60 s cap then, not on the tap. It rejects with a
 *   `TranscriberError`: `denied` (permission refused), `unavailable` (no device, insecure context, no
 *   `mediaDevices`) or `failed` (anything else).
 * - `session.stop()` ends the audio and resolves with the final transcript, trimmed or not, possibly
 *   empty. Partial results are never exposed (ADR-006). It rejects with a `failed` error. The overlay
 *   gives up after 10 s and calls `cancel()`, so `stop()` itself needs no timeout.
 * - `session.cancel()` closes the stream and discards everything. It's safe to call at any time, more
 *   than once, and after `stop()` has settled; the overlay calls it after every failure and timeout.
 *   A `stop()` still pending when `cancel()` is called may settle or not; the overlay ignores it.
 * - `onError` reports failures while recording (the mic track ends, the stream drops). After it fires
 *   the overlay shows the FR-024 error and calls `cancel()`.
 * - `onLevel` reports the input level, 0 to 1, while recording (optional for an implementation). Until
 *   the first report, the overlay's level dot pulses.
 */

export type TranscriberErrorKind = "denied" | "unavailable" | "failed";

export class TranscriberError extends Error {
  readonly kind: TranscriberErrorKind;

  constructor(kind: TranscriberErrorKind, message: string = `Transcriber: ${kind}`) {
    super(message);
    this.name = "TranscriberError";
    this.kind = kind;
  }
}

/** The kind of any rejection: a `TranscriberError`'s own, `failed` for anything else. */
export function errorKind(error: unknown): TranscriberErrorKind {
  return error instanceof TranscriberError ? error.kind : "failed";
}

export interface TranscriberCallbacks {
  /** The input level, 0 (silence) to 1, while recording. */
  onLevel?: (level: number) => void;
  /** A failure while recording, after `start()` resolved. */
  onError?: (error: TranscriberError) => void;
}

export interface TranscriberSession {
  /** End the audio and resolve with the final transcript (possibly empty). */
  stop(): Promise<string>;
  /** Close the stream and discard everything. Idempotent. */
  cancel(): void;
}

export interface Transcriber {
  /** Ask for the mic and start recording; resolves once recording has begun. */
  start(callbacks?: TranscriberCallbacks): Promise<TranscriberSession>;
}
