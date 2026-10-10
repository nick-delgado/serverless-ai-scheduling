/**
 * The browser end of voice capture (S6-02, #29): mic → AudioWorklet → 16 kHz s16le chunks, on the
 * path spike S-3 measured on real devices (ADR-006 "For #29", r2/A-2):
 *
 * - The `AudioContext` runs at the native rate (48 kHz everywhere measured), and the worklet
 *   downsamples. `createAudioContext` is called at the top of `start()`, before its first `await`,
 *   and `openMic` always awaits `ctx.resume()` before `audioWorklet.addModule`: Safari and Firefox
 *   create the context suspended once the tap handler has awaited something.
 * - The mic's errors become `TranscriberError`s: refused permission is `denied`; no device, no
 *   `mediaDevices` (an insecure context) or no AudioWorklet is `unavailable`; anything else `failed`.
 * - `close()` stops the mic's tracks and closes the context, so the browser's mic indicator goes off.
 */
import workletUrl from "./pcm-worklet.ts?worker&url";
import {
  CHUNK_SAMPLES,
  outputRate,
  PROCESSOR_NAME,
  type ProcessorOptions,
  TARGET_RATE,
  type WorkletMessage,
} from "./pcm";
import { TranscriberError } from "../transcriber";

/** How long `flush()` waits for the worklet's last chunk before giving up on it. */
export const FLUSH_TIMEOUT_MS = 250;

export interface MicHandlers {
  /** A 100 ms chunk of s16le PCM, and its level (0 to 1). */
  onChunk(pcm: Uint8Array, level: number): void;
  /** The mic's track ended (unplugged, revoked, taken by another app). */
  onEnded(): void;
}

export interface Mic {
  /** The rate of the PCM it produces (16 kHz unless the context is slower). */
  readonly sampleRate: number;
  /** Ask the worklet for its partial last chunk (delivered through `onChunk`) and stop it. */
  flush(): Promise<void>;
  /** Stop the tracks and close the context. Idempotent. */
  close(): Promise<void>;
}

/** A native-rate context; throws `unavailable` where Web Audio is missing. Synchronous on purpose. */
export function createAudioContext(): AudioContext {
  if (typeof AudioContext === "undefined") throw new TranscriberError("unavailable", "No Web Audio");
  return new AudioContext();
}

const DENIED = new Set(["NotAllowedError", "SecurityError"]);
const NO_DEVICE = new Set(["NotFoundError", "OverconstrainedError"]);

/** An error's `name`: `getUserMedia` rejects with a `DOMException`, which isn't an `Error` everywhere (jsdom). */
export function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" ? name : "";
}

/** A `getUserMedia` rejection as a `TranscriberError`. */
export function micError(error: unknown): TranscriberError {
  const name = errorName(error);
  if (DENIED.has(name)) return new TranscriberError("denied", `Mic: ${name}`);
  if (NO_DEVICE.has(name)) return new TranscriberError("unavailable", `Mic: ${name}`);
  return new TranscriberError("failed", `Mic: ${name || "unknown error"}`);
}

/**
 * Ask for the mic and start capturing into `ctx`, which this takes over: on any failure it stops
 * what it opened and closes the context before rejecting.
 */
export async function openMic(ctx: AudioContext, handlers: MicHandlers): Promise<Mic> {
  let media: MediaStream | undefined;
  try {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
      throw new TranscriberError("unavailable", "No mediaDevices or AudioWorklet (insecure context?)");
    }
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      throw micError(error);
    }
    await ctx.resume();
    await ctx.audioWorklet.addModule(workletUrl);
    return wire(ctx, media, handlers);
  } catch (error) {
    for (const track of media?.getTracks() ?? []) track.stop();
    await ctx.close().catch(() => undefined);
    throw error instanceof TranscriberError ? error : new TranscriberError("failed", describeError(error));
  }
}

function wire(ctx: AudioContext, media: MediaStream, handlers: MicHandlers): Mic {
  const processorOptions: ProcessorOptions = { targetRate: TARGET_RATE, chunkSamples: CHUNK_SAMPLES };
  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions,
  });
  let flushed: (() => void) | undefined;
  node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
    const message = event.data;
    if (message.pcm) handlers.onChunk(new Uint8Array(message.pcm), message.level);
    if (message.type === "flushed") flushed?.();
  };
  const source = ctx.createMediaStreamSource(media);
  source.connect(node);
  // Some engines only pull a node that reaches the destination; the worklet's output is silence.
  node.connect(ctx.destination);
  for (const track of media.getAudioTracks()) track.addEventListener("ended", () => handlers.onEnded());

  let closing: Promise<void> | undefined;
  return {
    sampleRate: outputRate(ctx.sampleRate),
    flush: () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        flushed = () => {
          clearTimeout(timer);
          resolve();
        };
        node.port.postMessage({ type: "flush" });
      }),
    close: () => {
      closing ??= (async () => {
        for (const track of media.getTracks()) track.stop();
        source.disconnect();
        node.disconnect();
        await ctx.close().catch(() => undefined);
      })();
      return closing;
    },
  };
}

/** An error's name and message, for a `TranscriberError`'s message (never shown to the patient). */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
