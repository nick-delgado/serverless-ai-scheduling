/**
 * Mic → AudioWorklet → 16 kHz s16le → Amazon Transcribe Streaming over WebSocket, instrumented for
 * spike S-3 (#10). Shaped like `apps/web/src/voice/transcriber.ts` (`start()` resolves once
 * recording has begun; `stop()` resolves with the outcome; `cancel()` is idempotent), but nothing is
 * imported from `apps/web` (r1/A-6), and it is not that interface. What #29 would change to lift it:
 * - `start(opts)` takes the region, credentials, tap time and spike options, where the `Transcriber`'s
 *   `start(callbacks)` fetches its own credentials; `onPartial` is spike-only (ADR-006 exposes no
 *   partials).
 * - `stop()` resolves with a `RunOutcome` (marks, socket and audio stats), never rejects, and applies
 *   its own 10 s timeout; the `Transcriber`'s `stop()` resolves with the transcript string, rejects
 *   with a `TranscriberError`, and leaves the timeout to the overlay.
 * - `onError` passes a spike `Failure`, not a `TranscriberError`, and `start()` rejects with raw
 *   errors rather than `denied` / `unavailable` / `failed`.
 * - Instrumentation to strip: the module replaces the page's global `WebSocket` with
 *   `ObservedWebSocket` at import, to see the socket's path and close code; also the marks, the
 *   visibility log and the `cold` count.
 *
 * Timing (r1/A-1), all `performance.now()` and relative to the mic tap:
 * - `stop` is the Send click or the 60 s auto-send; `lastFinal` is the arrival of the last
 *   `IsPartial: false` result, known once the response stream ends. latency = lastFinal − stop.
 * - also `streamEnd` (Send → end), and `wsOpen` and `firstResult` (tap → …), flagged cold or warm.
 * Credentials are fetched by the caller before the tap, outside every window.
 *
 * Failure (r1/Q-2 (a)): the stream errors; the WebSocket closes before Send, or after Send without a
 * clean code-1000 close; the stream ends with no final result at all; or the stream doesn't end, or
 * its last final arrives, more than 10 s after Send (FR-022). A run whose finals all arrived before
 * Send is a success, counted as 0 ms of stop→final (Nick's decision 50ed723/SPEC-2 (a) on PR #225).
 *
 * Ending the audio: the SDK's WebSocket handler closes the socket (code 1000) as soon as the audio
 * iterable ends, which can cut off the final results. So by default (`endMode: "empty-event"`) the
 * generator sends Transcribe's end-of-audio signal, an empty AudioEvent, and then stays open until
 * the server ends the response stream. `endMode: "end-iterable"` ends the iterable instead, to show
 * what that does.
 */
import workletUrl from "./pcm-worklet.ts?worker&url";
import type * as TranscribeSdk from "@aws-sdk/client-transcribe-streaming";

import type { WorkletMessage } from "./pcm-worklet";
import { redact } from "./redact";

export const TARGET_RATE = 16_000;
export const CHUNK_SAMPLES = 1_600; // 100 ms at 16 kHz (r1/A-2)
export const FINAL_TIMEOUT_MS = 10_000; // FR-022
export const STABILITY = "high"; // the r1/A-2 (corrected) variant: favours speed over accuracy
export const LANGUAGE_CODE = "en-US";
export const MEDIA_ENCODING = "pcm";

export interface StaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export type EndMode = "empty-event" | "end-iterable";

export interface StartOptions {
  region: string;
  credentials: StaticCredentials;
  stabilization: boolean;
  endMode?: EndMode;
  /** performance.now() at the tap, taken by the caller after its credential fetch. */
  tapAt: number;
  onLevel?: (level: number) => void;
  onPartial?: (text: string) => void;
  /** The stream failed while recording (before Send). */
  onError?: (failure: Failure) => void;
}

export type FailureKind = "error" | "closed-early" | "timeout" | "no-final" | "interrupted";

export interface Failure {
  kind: FailureKind;
  detail: string;
}

export interface WsInfo {
  path?: string;
  openAt?: number;
  closeAt?: number;
  closeCode?: number;
  closeReason?: string;
  wasClean?: boolean;
  errorAt?: number;
}

/** Milliseconds from the tap. */
export type Marks = Partial<
  Record<
    | "sdkLoaded"
    | "micGranted"
    | "contextReady"
    | "workletReady"
    | "recording"
    | "sendResolved"
    | "wsOpen"
    | "firstChunkSent"
    | "firstResult"
    | "stop"
    | "audioEnded"
    | "lastFinal"
    | "streamEnd",
    number
  >
>;

export interface RunOutcome {
  ok: boolean;
  failure?: Failure;
  cold: boolean;
  stopReason?: "send" | "auto";
  transcript: string;
  finalCount: number;
  finalsAfterStop: number;
  /** lastFinal − stop; undefined when there was no final. Negative means every final came before Send. */
  latencyMs?: number;
  sendToEndMs?: number;
  marks: Marks;
  ws: WsInfo;
  audio: {
    contextRate: number;
    contextStateAtCreate: AudioContextState;
    workletInputRate?: number;
    trackSettingsRate?: number;
    chunksSent: number;
    bytesSent: number;
    secondsSent: number;
    /** Highest RMS level of any 100 ms chunk (0 to 1): near 0 means the mic sent silence. */
    maxLevel?: number;
  };
  /** Page visibility changes during the run (r1/Q-5 tab-switch and lock-screen tries). */
  visibility: { at: number; state: DocumentVisibilityState }[];
  micTrackEndedAt?: number;
}

export interface CaptureSession {
  stop(reason?: "send" | "auto"): Promise<RunOutcome>;
  cancel(): void;
}

// ---- WebSocket observation ---------------------------------------------------------------------
// The SDK's handler constructs the global `WebSocket` at call time. A subclass reports open and
// close to the active run. Only the URL path is kept: the query holds the signed credentials.

let observer: ((ws: WebSocket) => void) | undefined;
const NativeWebSocket = globalThis.WebSocket;
class ObservedWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    observer?.(this);
  }
}
globalThis.WebSocket = ObservedWebSocket;

let streamsThisLoad = 0;

type Sdk = typeof TranscribeSdk;
let sdkPromise: Promise<Sdk> | undefined;
/** The dynamic import that ADR-006 measures (r1/A-3): only on first mic use. */
function loadSdk(): Promise<Sdk> {
  sdkPromise ??= import("@aws-sdk/client-transcribe-streaming");
  return sdkPromise;
}

const END = Symbol("end");

/**
 * The capture context, running, with the worklet loaded. A throw on the way (a rejected `resume()` or
 * `addModule()`) stops the mic's tracks and closes the context before it propagates, since the caller
 * holds nothing to release yet.
 */
async function openContext(
  media: MediaStream,
  mark: (name: "contextReady" | "workletReady") => void,
): Promise<{ ctx: AudioContext; contextStateAtCreate: AudioContextState }> {
  let ctx: AudioContext | undefined;
  try {
    ctx = new AudioContext();
    const contextStateAtCreate = ctx.state;
    if (ctx.state === "suspended") await ctx.resume();
    mark("contextReady");
    await ctx.audioWorklet.addModule(workletUrl);
    mark("workletReady");
    return { ctx, contextStateAtCreate };
  } catch (error) {
    for (const track of media.getTracks()) track.stop();
    await ctx?.close().catch(() => undefined);
    throw error;
  }
}

export async function start(opts: StartOptions): Promise<CaptureSession> {
  const t = () => performance.now() - opts.tapAt;
  const marks: Marks = {};
  const ws: WsInfo = {};
  const visibility: RunOutcome["visibility"] = [];
  const cold = streamsThisLoad === 0;
  streamsThisLoad += 1;
  const endMode = opts.endMode ?? "empty-event";

  const sdk = await loadSdk();
  marks.sdkLoaded = t();

  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  marks.micGranted = t();
  const track = media.getAudioTracks()[0];
  let micTrackEndedAt: number | undefined;

  const { ctx, contextStateAtCreate } = await openContext(media, (mark) => (marks[mark] = t()));

  // ---- audio queue ------------------------------------------------------------------------------
  const queue: (Uint8Array | typeof END)[] = [];
  let wake: (() => void) | undefined;
  const enqueue = (item: Uint8Array | typeof END) => {
    queue.push(item);
    wake?.();
    wake = undefined;
  };
  let chunksSent = 0;
  let bytesSent = 0;
  let workletInputRate: number | undefined;
  let maxLevel = 0;
  let flushed: (() => void) | undefined;

  const node = new AudioWorkletNode(ctx, "pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions: { targetRate: TARGET_RATE, chunkSamples: CHUNK_SAMPLES },
  });
  node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
    const msg = event.data;
    if (msg.type === "ready") workletInputRate = msg.inputRate;
    else if (msg.type === "chunk") {
      enqueue(new Uint8Array(msg.pcm));
      maxLevel = Math.max(maxLevel, msg.level);
      opts.onLevel?.(msg.level);
    } else {
      if (msg.pcm) enqueue(new Uint8Array(msg.pcm));
      flushed?.();
    }
  };
  const source = ctx.createMediaStreamSource(media);
  source.connect(node);
  // Some engines only pull a node that reaches the destination; the worklet writes silence.
  node.connect(ctx.destination);
  marks.recording = t();

  let outputDone!: () => void;
  const outputEnded = new Promise<void>((resolve) => (outputDone = resolve));

  async function* audioStream() {
    for (;;) {
      if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      const item = queue.shift();
      if (item === undefined) continue;
      if (item === END) break;
      if (chunksSent === 0) marks.firstChunkSent = t();
      chunksSent += 1;
      bytesSent += item.byteLength;
      yield { AudioEvent: { AudioChunk: item } };
    }
    marks.audioEnded = t();
    if (endMode === "empty-event") {
      yield { AudioEvent: { AudioChunk: new Uint8Array(0) } };
      await outputEnded;
    }
  }

  // ---- stream -----------------------------------------------------------------------------------
  observer = (socket) => {
    observer = undefined;
    try {
      ws.path = new URL(socket.url).pathname;
    } catch {
      ws.path = "<unparsed>";
    }
    socket.addEventListener("open", () => (ws.openAt = marks.wsOpen = t()));
    socket.addEventListener("error", () => (ws.errorAt = t()));
    socket.addEventListener("close", (e) => {
      ws.closeAt = t();
      ws.closeCode = e.code;
      ws.closeReason = e.reason;
      ws.wasClean = e.wasClean;
    });
  };

  const client = new sdk.TranscribeStreamingClient({ region: opts.region, credentials: opts.credentials });
  const finals: string[] = [];
  let finalsAfterStop = 0;
  let stopped = false;
  let cancelled = false;
  let streamFailure: Failure | undefined;

  const onVisibility = () => visibility.push({ at: t(), state: document.visibilityState });
  document.addEventListener("visibilitychange", onVisibility);
  track?.addEventListener("ended", () => (micTrackEndedAt = t()));

  const streamDone = (async () => {
    try {
      const response = await client.send(
        new sdk.StartStreamTranscriptionCommand({
          LanguageCode: LANGUAGE_CODE,
          MediaEncoding: MEDIA_ENCODING,
          MediaSampleRateHertz: TARGET_RATE,
          AudioStream: audioStream(),
          ...(opts.stabilization
            ? { EnablePartialResultsStabilization: true, PartialResultsStability: STABILITY }
            : {}),
        }),
      );
      marks.sendResolved = t();
      for await (const event of response.TranscriptResultStream ?? []) {
        for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
          marks.firstResult ??= t();
          const text = result.Alternatives?.[0]?.Transcript ?? "";
          if (result.IsPartial) opts.onPartial?.([...finals, text].join(" "));
          else {
            finals.push(text);
            marks.lastFinal = t();
            if (stopped) finalsAfterStop += 1;
            opts.onPartial?.(finals.join(" "));
          }
        }
      }
      marks.streamEnd = t();
      if (!stopped && !cancelled) {
        streamFailure = {
          kind: "closed-early",
          detail: `stream ended before Send (ws close ${ws.closeCode ?? "?"})`,
        };
      }
    } catch (error) {
      marks.streamEnd = t();
      if (!cancelled) streamFailure = { kind: "error", detail: describe(error) };
    } finally {
      outputDone();
    }
    if (streamFailure && !stopped && !cancelled) opts.onError?.(streamFailure);
  })();

  let releasePromise: Promise<void> | undefined;
  function release(): Promise<void> {
    releasePromise ??= (async () => {
      document.removeEventListener("visibilitychange", onVisibility);
      for (const tr of media.getTracks()) tr.stop();
      source.disconnect();
      node.disconnect();
      await ctx.close().catch(() => undefined);
    })();
    return releasePromise;
  }

  function outcome(failure: Failure | undefined, stopReason: RunOutcome["stopReason"]): RunOutcome {
    const latencyMs =
      marks.lastFinal !== undefined && marks.stop !== undefined ? marks.lastFinal - marks.stop : undefined;
    return {
      ok: !failure,
      ...(failure ? { failure } : {}),
      cold,
      stopReason,
      transcript: finals.join(" ").trim(),
      finalCount: finals.length,
      finalsAfterStop,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(marks.streamEnd !== undefined && marks.stop !== undefined
        ? { sendToEndMs: marks.streamEnd - marks.stop }
        : {}),
      marks,
      ws,
      audio: {
        contextRate: ctx.sampleRate,
        contextStateAtCreate,
        ...(workletInputRate !== undefined ? { workletInputRate } : {}),
        ...(track?.getSettings().sampleRate !== undefined
          ? { trackSettingsRate: track.getSettings().sampleRate }
          : {}),
        chunksSent,
        bytesSent,
        secondsSent: bytesSent / 2 / TARGET_RATE,
        maxLevel: Number(maxLevel.toFixed(4)),
      },
      visibility,
      ...(micTrackEndedAt !== undefined ? { micTrackEndedAt } : {}),
    };
  }

  return {
    async stop(reason = "send") {
      if (stopped || cancelled) throw new Error("stop() called twice");
      stopped = true;
      const stopAt = t();
      marks.stop = stopAt;
      if (streamFailure) {
        await release();
        return outcome(streamFailure, reason);
      }
      // Ask the worklet for the partial last chunk, then end the audio.
      await Promise.race([
        new Promise<void>((resolve) => {
          flushed = resolve;
          node.port.postMessage({ type: "flush" });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
      enqueue(END);
      void release();
      const timedOut = await Promise.race([
        streamDone.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), FINAL_TIMEOUT_MS)),
      ]);
      let failure: Failure | undefined = streamFailure;
      if (timedOut) {
        failure = { kind: "timeout", detail: `no stream end within ${FINAL_TIMEOUT_MS} ms of Send` };
        client.destroy();
      } else if (!failure && finals.length === 0) {
        failure = {
          kind: "no-final",
          detail: `stream ended with no final result (ws close ${ws.closeCode ?? "?"})`,
        };
      } else if (!failure && ws.closeCode !== undefined && (ws.closeCode !== 1000 || ws.wasClean === false)) {
        // The SDK ends the response stream without an error on any close, so finals already received
        // would otherwise hide a socket that dropped after Send.
        failure = {
          kind: "closed-early",
          detail: `socket closed after Send without a clean 1000 (code ${ws.closeCode}, clean ${String(ws.wasClean)})`,
        };
      } else if (!failure && marks.lastFinal !== undefined && marks.lastFinal - stopAt > FINAL_TIMEOUT_MS) {
        failure = { kind: "timeout", detail: "last final more than 10 s after Send" };
      }
      return outcome(failure, reason);
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      enqueue(END);
      outputDone();
      client.destroy();
      void release();
    },
  };
}

/** An error's name, HTTP status and redacted message, for the results file. */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return redact(`${error.name}${status ? ` (HTTP ${status})` : ""}: ${error.message}`);
  }
  if (typeof Event !== "undefined" && error instanceof Event) return `Event: ${error.type}`;
  try {
    return redact(JSON.stringify(error));
  } catch {
    return String(error);
  }
}
