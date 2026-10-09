/**
 * The production `Transcriber` (S6-02, #29; ADR-006, FR-022 to FR-024): mic → AudioWorklet → 16 kHz
 * PCM → Amazon Transcribe Streaming, with the patient's Identity Pool credentials. It follows #28's
 * interface (`../transcriber.ts`); the flow is spike S-3's `capture.ts`, adapted as ADR-006 lists.
 *
 * - `start()` creates the `AudioContext` before its first `await` (r2/A-2), starts loading the SDK
 *   and fetching credentials, asks for the mic, and resolves once capture runs. The stream opens in
 *   the background; chunks wait in a queue until it does, so the first words aren't lost (r1/A-6).
 * - Send (`stop()`, also the 60 s auto-send) flushes the worklet, releases the mic, and ends the audio
 *   with an empty `AudioEvent` while the input stays open (ADR-006 "For #29": ending the iterable makes
 *   the SDK close the socket at once and the finals are lost). `stop()` resolves when Transcribe ends
 *   the response stream, with the first alternative of each final result, joined and trimmed
 *   (r1/A-7); no final gives "". It rejects with `failed` if the stream errors.
 * - `cancel()` destroys the client (closing the socket), ends the input, releases the mic and
 *   discards everything. #28's overlay calls it on Cancel, Esc, unmount, after `onError`, and when
 *   its 10 s timer after Send gives up; this class has no timeout of its own.
 * - While recording, a stream error, the stream ending early, the mic track ending, or the page
 *   becoming hidden (r2/Q-1 (a): iOS silently stops the audio) calls `onError` with `failed` and
 *   releases everything. Nothing is retried automatically. Hidden before recording (the permission
 *   prompt) or after Send isn't an error.
 * - Partial results are never exposed (ADR-006). Nothing is stored.
 *
 * Construction touches no browser API and loads nothing (r2/A-3): `TranscriberContext` builds one
 * at module load, and jsdom renders of `<ChatPage>` must not need audio stubs.
 */
import type { AudioStream, TranscriptResultStream } from "@aws-sdk/client-transcribe-streaming";

import type { AwsCredentials } from "../../auth/authService";
import {
  type Transcriber,
  type TranscriberCallbacks,
  TranscriberError,
  type TranscriberSession,
} from "../transcriber";
import { createAudioContext, describeError, type Mic, type MicHandlers, openMic } from "./mic";
import type { StreamClient, StreamClientFactory } from "./streamClient";

export const LANGUAGE_CODE = "en-US";

/** Why a stream failed, for the timing record (#29 AC6). */
export type FailureReason = "error" | "closed-early" | "hidden" | "mic-ended";

export type StreamOutcome =
  | { status: "ok"; transcript: string }
  | { status: "failed"; reason: FailureReason; detail: string }
  | { status: "cancelled"; afterSend: boolean };

/**
 * Hooks for the opt-in timing build (`VITE_VOICE_TIMING=1`, r2/Q-2 (a)): one observer per recording.
 * The timing record itself lives in `timing.ts`, which other builds leave out.
 */
export interface StreamObserver {
  /** `start()` resolved: recording has begun. */
  recording(): void;
  /** Send, or the 60 s auto-send: `stop()` was called. */
  send(): void;
  /** A final (`IsPartial: false`) result arrived. */
  final(): void;
  /** The recording ended, once. */
  end(outcome: StreamOutcome): void;
}

export interface RealTranscriberOptions {
  /** The Identity Pool's region, from its ID's prefix (r1/A-4). */
  region: string;
  /** The patient's Identity Pool credentials (`getAwsCredentials` from `src/auth`). */
  getCredentials: () => Promise<AwsCredentials | undefined>;
  /** Loads the SDK adapter; the default is the lazy `import()` of `./streamClient`. */
  loadClient?: () => Promise<StreamClientFactory>;
  createAudioContext?: () => AudioContext;
  openMic?: (ctx: AudioContext, handlers: MicHandlers) => Promise<Mic>;
  /** A timing observer for each recording, or none. */
  observe?: () => StreamObserver | undefined;
}

/** The lazy load of the SDK adapter (r1/A-5): only on first mic use. */
export const loadStreamClient = (): Promise<StreamClientFactory> =>
  import("./streamClient").then((module) => module.createStreamClient);

/** The region of an Identity Pool ID such as `us-east-1:…` (r1/A-4). */
export function identityPoolRegion(identityPoolId: string): string {
  return identityPoolId.slice(0, Math.max(0, identityPoolId.indexOf(":")));
}

export class RealTranscriber implements Transcriber {
  readonly options: RealTranscriberOptions;
  private readonly deps: Required<Omit<RealTranscriberOptions, "observe">>;

  constructor(options: RealTranscriberOptions) {
    this.options = options;
    this.deps = { loadClient: loadStreamClient, createAudioContext, openMic, ...options };
  }

  async start(callbacks: TranscriberCallbacks = {}): Promise<TranscriberSession> {
    const { deps } = this;
    // Before the first await (r2/A-2), so Safari ties it to the tap.
    const ctx = deps.createAudioContext();
    const run = new StreamRun(callbacks, this.options.observe?.());
    const client = Promise.all([deps.loadClient(), deps.getCredentials()]);
    client.catch(() => undefined); // read by `stream()`; a rejection before then isn't unhandled

    await run.open(() => deps.openMic(ctx, run.handlers));
    run.stream(client, deps.region);
    return { stop: () => run.stop(), cancel: () => run.cancel() };
  }
}

type RunState = "starting" | "recording" | "stopping" | "done" | "failed" | "cancelled";

const END = Symbol("end");

/** A Transcribe exception the response stream carried as an event rather than throwing. */
function streamException(event: TranscriptResultStream): Error | undefined {
  for (const [name, value] of Object.entries(event)) {
    if (name.endsWith("Exception") && value) {
      const error = new Error((value as { Message?: string }).Message ?? name);
      error.name = name;
      return error;
    }
  }
  return undefined;
}

/** One recording: the mic, the queue of chunks, the stream and its results. */
class StreamRun {
  private state: RunState = "starting";
  private mic: Mic | undefined;
  private client: StreamClient | undefined;
  private readonly queue: (Uint8Array | typeof END)[] = [];
  private wake: (() => void) | undefined;
  private readonly finals: string[] = [];
  private endOutput!: () => void;
  private readonly outputEnded = new Promise<void>((resolve) => (this.endOutput = resolve));
  private settle!: { resolve: (transcript: string) => void; reject: (error: TranscriberError) => void };
  private readonly result = new Promise<string>((resolve, reject) => (this.settle = { resolve, reject }));

  readonly handlers: MicHandlers = {
    onChunk: (pcm, level) => {
      this.enqueue(pcm); // after Cancel or a failure the input has ended, so nothing reads it
      if (this.state === "recording") this.callbacks.onLevel?.(level);
    },
    onEnded: () => this.fail("mic-ended", "The mic's track ended"),
  };

  constructor(
    private readonly callbacks: TranscriberCallbacks,
    private readonly observer: StreamObserver | undefined,
  ) {
    this.result.catch(() => undefined); // only `stop()`'s caller reads it
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") this.fail("hidden", "The page was hidden while recording");
  };

  /** Open the mic; on success recording has begun. */
  async open(openMic: () => Promise<Mic>): Promise<void> {
    this.mic = await openMic();
    this.state = "recording";
    document.addEventListener("visibilitychange", this.onVisibility);
    this.observer?.recording();
  }

  /** The stream, in the background: results are collected until Transcribe ends it. */
  stream(client: Promise<[StreamClientFactory, AwsCredentials | undefined]>, region: string): void {
    void (async () => {
      try {
        const [factory, credentials] = await client;
        if (!this.active()) return;
        if (!credentials) throw new TranscriberError("failed", "No AWS credentials for voice");
        this.client = factory(region, credentials);
        const response = await this.client.start({
          LanguageCode: LANGUAGE_CODE,
          MediaEncoding: "pcm",
          MediaSampleRateHertz: this.mic?.sampleRate,
          AudioStream: this.audio(),
        });
        for await (const event of response.TranscriptResultStream ?? []) {
          const exception = streamException(event);
          if (exception) throw exception;
          for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
            if (result.IsPartial) continue;
            this.finals.push(result.Alternatives?.[0]?.Transcript ?? "");
            this.observer?.final();
          }
        }
        this.ended(undefined);
      } catch (error) {
        this.ended(error);
      } finally {
        this.endOutput();
      }
    })();
  }

  async stop(): Promise<string> {
    if (this.state !== "recording") throw new TranscriberError("failed", `stop() while ${this.state}`);
    this.state = "stopping";
    this.observer?.send();
    document.removeEventListener("visibilitychange", this.onVisibility);
    await this.mic?.flush();
    this.enqueue(END);
    void this.mic?.close();
    return this.result;
  }

  cancel(): void {
    if (this.state === "cancelled") return;
    const live = this.active();
    const afterSend = this.state === "stopping";
    this.state = "cancelled";
    this.release();
    if (live) this.observer?.end({ status: "cancelled", afterSend });
    this.settle.reject(new TranscriberError("failed", "Cancelled"));
  }

  private active(): boolean {
    return this.state === "starting" || this.state === "recording" || this.state === "stopping";
  }

  /** The audio Transcribe reads: queued chunks, then the empty event, then open until the response ends. */
  private async *audio(): AsyncGenerator<AudioStream> {
    for (;;) {
      if (this.queue.length === 0) await new Promise<void>((resolve) => (this.wake = resolve));
      const item = this.queue.shift();
      if (item === END) break;
      if (item) yield { AudioEvent: { AudioChunk: item } };
    }
    if (this.state !== "stopping") return;
    yield { AudioEvent: { AudioChunk: new Uint8Array(0) } };
    await this.outputEnded;
  }

  private enqueue(item: Uint8Array | typeof END): void {
    this.queue.push(item);
    this.wake?.();
    this.wake = undefined;
  }

  /** The response stream ended, with an error or without. */
  private ended(error: unknown): void {
    if (this.state === "stopping") {
      this.state = "done";
      if (error === undefined) {
        const transcript = this.finals.join(" ").trim();
        this.observer?.end({ status: "ok", transcript });
        this.settle.resolve(transcript);
      } else {
        this.observer?.end({ status: "failed", reason: "error", detail: describeError(error) });
        this.settle.reject(new TranscriberError("failed", describeError(error)));
      }
      return;
    }
    if (error === undefined) this.fail("closed-early", "The stream ended before Send");
    else this.fail("error", describeError(error));
  }

  /** A failure while recording: report it once, release everything. */
  private fail(reason: FailureReason, detail: string): void {
    if (this.state !== "recording") return;
    this.state = "failed";
    this.release();
    this.observer?.end({ status: "failed", reason, detail });
    const error = new TranscriberError("failed", detail);
    this.settle.reject(error);
    this.callbacks.onError?.(error);
  }

  /** Stop listening, close the socket, end the input and release the mic. */
  private release(): void {
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.client?.destroy();
    this.enqueue(END);
    this.endOutput();
    void this.mic?.close();
  }
}
