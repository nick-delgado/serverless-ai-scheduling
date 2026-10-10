/**
 * The capture worklet (S6-02, #29; ADR-006): mono Float32 at the context's native rate in, 16 kHz
 * s16le chunks out, posted to the page as transferable ArrayBuffers. All the arithmetic is in
 * `pcm.ts`; this file only feeds it and answers `flush` with the partial last chunk, then stops.
 *
 * `mic.ts` loads it with Vite's `?worker&url`, which bundles `pcm.ts` into it. TS 6.0 ships no
 * AudioWorklet global scope types, so the three globals used here are declared locally (as in spike
 * S-3's worklet, which this replaces in the app).
 */
import { Downsampler, PROCESSOR_NAME, type ProcessorOptions, type WorkletMessage } from "./pcm";

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options: never) => AudioWorkletProcessor): void;
declare const sampleRate: number;

export class PcmCapture extends AudioWorkletProcessor {
  private readonly downsampler: Downsampler;
  private stopped = false;

  constructor(options: { processorOptions: ProcessorOptions }) {
    super(options);
    const { targetRate, chunkSamples } = options.processorOptions;
    this.downsampler = new Downsampler(sampleRate, targetRate, chunkSamples);
    this.port.onmessage = (event: MessageEvent<{ type: "flush" }>) => {
      if (event.data.type === "flush") this.flush();
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const chunk of this.downsampler.push(channel)) {
      this.port.postMessage({ type: "chunk", ...chunk } satisfies WorkletMessage, [chunk.pcm]);
    }
    return true;
  }

  private flush(): void {
    this.stopped = true;
    const last = this.downsampler.flush();
    const message: WorkletMessage = { type: "flushed", pcm: last?.pcm ?? null, level: last?.level ?? 0 };
    this.port.postMessage(message, last ? [last.pcm] : []);
  }
}

registerProcessor(PROCESSOR_NAME, PcmCapture);
