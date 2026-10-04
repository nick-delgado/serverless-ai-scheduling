/**
 * The recording overlay's state (S6-01, #28; FR-020 to FR-024). Everything browser-facing is the
 * `Transcriber`'s job; this hook only runs the phases and the two timers:
 *
 * - The m:ss timer and the 60 s cap start when `start()` resolves (recording has begun), not on the
 *   tap. Elapsed time is read from the start timestamp on each tick, never counted from ticks, so a
 *   throttled background tab can't stretch the cap. At 60 s the recording is sent as if Send were
 *   pressed, and the timer shows 1:00.
 * - Send (or the cap) switches to "Transcribing…" and starts a 10 s timer. If no final transcript
 *   arrives by then, or the Transcriber fails, the FR-024 error shows and the session is cancelled. A
 *   transcript that arrives after that is discarded.
 * - The transcript is trimmed here: a blank one shows "I didn't catch that" and sends nothing, because
 *   `send()`'s `false` can't say whether the text was blank or the chat was busy. A `false` for a
 *   non-blank transcript keeps the overlay open with the text, for another Send.
 * - Cancel, Esc and unmounting cancel the session and discard everything, in every phase.
 *
 * Each recording gets an attempt number; a callback from an older attempt (a `start()` that resolves
 * after Cancel, a transcript after the timeout) does nothing, except cancel a session it was handed.
 */
import { useEffect, useRef, useState } from "react";

import { errorKind, type Transcriber, type TranscriberSession } from "./transcriber";

/** FR-021: the recording stops and is sent at 60 s. */
export const RECORDING_CAP_MS = 60_000;
/** FR-022: the FR-024 error shows if no final transcript arrives within 10 s of Send. */
export const FINAL_TIMEOUT_MS = 10_000;
/** How often the timer re-reads the clock. */
export const TICK_MS = 250;

export type RecordingPhase =
  | { name: "starting" }
  | { name: "recording" }
  | { name: "transcribing" }
  | { name: "empty" }
  | { name: "failed" }
  | { name: "unsent"; text: string };

/** Why the mic can't be used; shown beside the composer, not in the overlay. */
export type MicNotice = "denied" | "unavailable";

export interface UseRecordingOptions {
  transcriber: Transcriber | null;
  /** Post the transcript; `false` if it wasn't taken. */
  onTranscript: (text: string) => boolean;
}

export interface Recording {
  /** The overlay's phase, or null when it's closed. */
  phase: RecordingPhase | null;
  notice: MicNotice | null;
  /** Milliseconds recorded, at most `RECORDING_CAP_MS`. */
  elapsedMs: number;
  /** The latest input level, 0 to 1. */
  level: number;
  /** Open the overlay and start recording (also "Record again"). */
  record: () => void;
  /** Send: stop recording and wait for the final transcript. */
  send: () => void;
  /** Offer an unsent transcript again. */
  resend: () => void;
  /** Cancel, Esc, "Type instead": discard everything and close. */
  close: () => void;
}

/** m:ss, from whole seconds. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

export function useRecording({ transcriber, onTranscript }: UseRecordingOptions): Recording {
  const [phase, setPhase] = useState<RecordingPhase | null>(null);
  const [notice, setNotice] = useState<MicNotice | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);

  const attempt = useRef(0);
  const session = useRef<TranscriberSession | null>(null);
  const startedAt = useRef(0);
  const ticker = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const finalTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Read when a transcript arrives, not when the recording started.
  const latest = useRef(onTranscript);
  useEffect(() => {
    latest.current = onTranscript;
  });

  // The ref-only helpers below are recreated each render but read nothing from it, so any copy works.

  /** Make every pending callback stale, stop the timers, and cancel the session. */
  const discard = () => {
    attempt.current += 1;
    clearInterval(ticker.current);
    clearTimeout(finalTimer.current);
    session.current?.cancel();
    session.current = null;
  };

  const fail = () => {
    discard();
    setPhase({ name: "failed" });
  };

  const deliver = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0) {
      setPhase({ name: "empty" });
      return;
    }
    if (latest.current(text)) setPhase(null);
    else setPhase({ name: "unsent", text });
  };

  const send = () => {
    const current = session.current;
    if (!current) return;
    clearInterval(ticker.current);
    setElapsedMs(Math.min(Date.now() - startedAt.current, RECORDING_CAP_MS));
    const id = attempt.current;
    setPhase({ name: "transcribing" });
    // `discard` clears this timer, so it only fires for the current attempt.
    finalTimer.current = setTimeout(fail, FINAL_TIMEOUT_MS);
    current.stop().then(
      (transcript) => {
        if (attempt.current !== id) return;
        discard();
        deliver(transcript);
      },
      () => {
        if (attempt.current === id) fail();
      },
    );
  };

  const record = () => {
    if (!transcriber) return;
    discard();
    const id = attempt.current;
    setNotice(null);
    setElapsedMs(0);
    setLevel(0);
    setPhase({ name: "starting" });
    transcriber
      .start({
        onLevel: (value) => {
          if (attempt.current === id) setLevel(value);
        },
        onError: () => {
          if (attempt.current === id) fail();
        },
      })
      .then(
        (started) => {
          if (attempt.current !== id) {
            started.cancel();
            return;
          }
          session.current = started;
          startedAt.current = Date.now();
          setPhase({ name: "recording" });
          ticker.current = setInterval(() => {
            const ms = Date.now() - startedAt.current;
            if (ms >= RECORDING_CAP_MS) send();
            else setElapsedMs(ms);
          }, TICK_MS);
        },
        (error: unknown) => {
          if (attempt.current !== id) return;
          const kind = errorKind(error);
          if (kind === "failed") {
            fail();
            return;
          }
          setPhase(null);
          setNotice(kind);
        },
      );
  };

  const resend = () => {
    if (phase?.name === "unsent" && latest.current(phase.text)) setPhase(null);
  };

  const close = () => {
    discard();
    setPhase(null);
  };

  // Unmounting (sign-out, a route change) discards the recording. `discard` reads only refs.
  const discardRef = useRef(discard);
  useEffect(() => () => discardRef.current(), []);

  return { phase, notice, elapsedMs, level, record, send, resend, close };
}
