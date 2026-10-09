/**
 * The capture worklet: mono Float32 at the context's native rate in, 16 kHz s16le chunks of
 * `chunkSamples` samples (1600 = 100 ms, r1/A-2) out, posted as transferable ArrayBuffers.
 *
 * Downsampling is a box-filter decimator: each output sample is the mean of the input samples that
 * fall in its 1/16000 s window. It handles non-integer ratios (44.1 kHz → 16 kHz) and is a crude
 * low-pass, enough for speech recognition; #29 owns the tested production version (r1/A-10).
 *
 * TS 6.0 ships no AudioWorklet global scope types, so the three globals this file uses are
 * declared locally (r1/A-5). The file is loaded with Vite's `?worker&url`, which compiles it.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options: never) => AudioWorkletProcessor): void;
declare const sampleRate: number;

interface CaptureOptions {
  processorOptions: { targetRate: number; chunkSamples: number };
}

export type WorkletMessage =
  | { type: "ready"; inputRate: number }
  | { type: "chunk"; pcm: ArrayBuffer; level: number }
  | { type: "flushed"; pcm: ArrayBuffer | null };

class PcmCapture extends AudioWorkletProcessor {
  private readonly ratio: number;
  private readonly out: Int16Array;
  private filled = 0;
  private acc = 0;
  private count = 0;
  private progress = 0;
  private sumSquares = 0;
  private stopped = false;

  constructor(options: CaptureOptions) {
    super(options);
    const { targetRate, chunkSamples } = options.processorOptions;
    this.ratio = sampleRate / targetRate;
    this.out = new Int16Array(chunkSamples);
    this.port.onmessage = (event: MessageEvent<{ type: "flush" }>) => {
      if (event.data.type === "flush") this.flush();
    };
    this.port.postMessage({ type: "ready", inputRate: sampleRate } satisfies WorkletMessage);
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const x of channel) {
      this.acc += x;
      this.count += 1;
      this.progress += 1;
      if (this.progress >= this.ratio) {
        this.push(this.acc / this.count);
        this.acc = 0;
        this.count = 0;
        this.progress -= this.ratio;
      }
    }
    return true;
  }

  private push(sample: number): void {
    const s = Math.max(-1, Math.min(1, sample));
    this.out[this.filled] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    this.sumSquares += s * s;
    this.filled += 1;
    if (this.filled === this.out.length) {
      const level = Math.sqrt(this.sumSquares / this.filled);
      const pcm = this.take();
      this.port.postMessage({ type: "chunk", pcm, level } satisfies WorkletMessage, [pcm]);
    }
  }

  /** The filled part of the buffer as little-endian bytes (DataView, whatever the host's order). */
  private take(): ArrayBuffer {
    const bytes = new ArrayBuffer(this.filled * 2);
    const view = new DataView(bytes);
    for (let i = 0; i < this.filled; i += 1) view.setInt16(i * 2, this.out[i] ?? 0, true);
    this.filled = 0;
    this.sumSquares = 0;
    return bytes;
  }

  private flush(): void {
    this.stopped = true;
    const pcm = this.filled > 0 ? this.take() : null;
    this.port.postMessage({ type: "flushed", pcm } satisfies WorkletMessage, pcm ? [pcm] : []);
  }
}

registerProcessor("pcm-capture", PcmCapture);
