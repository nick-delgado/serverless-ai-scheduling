/**
 * Mic samples → Amazon Transcribe's audio format (S6-02, #29; ADR-006): mono 16 kHz signed 16-bit
 * little-endian PCM, in chunks of 1600 samples (100 ms, r1/A-6). Pure, so jsdom tests it; the worklet
 * (`pcm-worklet.ts`) only feeds it the context's samples and posts what comes out.
 *
 * Downsampling is a box-filter decimator, moved from spike S-3 (`spikes/s3-transcribe-browser/src/
 * pcm-worklet.ts`): each output sample is the mean of the input samples in its 1/16000 s window. It
 * handles non-integer ratios (44.1 kHz → 16 kHz) and is a crude low-pass, enough for speech
 * recognition. Every measured browser ran its context at 48 kHz (ADR-006). An input slower than the
 * target isn't upsampled: it passes through at its own rate, which `outputRate` reports for the stream.
 */

export const TARGET_RATE = 16_000;
/** 100 ms at 16 kHz (ADR-006 "For #29": keep 1600 samples). */
export const CHUNK_SAMPLES = 1_600;
/** The name the worklet registers its processor under. */
export const PROCESSOR_NAME = "pcm-capture";

/** One chunk: s16le bytes, and its RMS level (0 to 1) for the overlay's level dot. */
export interface PcmChunk {
  pcm: ArrayBuffer;
  level: number;
}

/** What the worklet posts to the page. */
export type WorkletMessage =
  | { type: "chunk"; pcm: ArrayBuffer; level: number }
  /** The answer to a `flush`: the partial last chunk, if any. */
  | { type: "flushed"; pcm: ArrayBuffer | null; level: number };

/** The options the page passes to the worklet's processor. */
export interface ProcessorOptions {
  targetRate: number;
  chunkSamples: number;
}

/** The rate the PCM comes out at: the target, or the input's own when that's slower. */
export function outputRate(inputRate: number, targetRate: number = TARGET_RATE): number {
  return Math.min(inputRate, targetRate);
}

/** A float sample (clamped to -1..1) as a signed 16-bit integer. */
export function toInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample));
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

/** The first `length` samples as little-endian bytes (a DataView, whatever the host's byte order). */
export function encodeS16le(samples: Int16Array, length: number = samples.length): ArrayBuffer {
  const bytes = new ArrayBuffer(length * 2);
  const view = new DataView(bytes);
  samples.subarray(0, length).forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return bytes;
}

export class Downsampler {
  private readonly ratio: number;
  private readonly out: Int16Array;
  private filled = 0;
  private sumSquares = 0;
  private acc = 0;
  private count = 0;
  private progress = 0;

  constructor(inputRate: number, targetRate: number = TARGET_RATE, chunkSamples: number = CHUNK_SAMPLES) {
    this.ratio = inputRate / outputRate(inputRate, targetRate);
    this.out = new Int16Array(chunkSamples);
  }

  /** Feed one block of input samples; returns the chunks it completed, oldest first. */
  push(input: Float32Array): PcmChunk[] {
    const chunks: PcmChunk[] = [];
    for (const x of input) {
      this.acc += x;
      this.count += 1;
      this.progress += 1;
      if (this.progress >= this.ratio) {
        const chunk = this.emit(this.acc / this.count);
        if (chunk) chunks.push(chunk);
        this.acc = 0;
        this.count = 0;
        this.progress -= this.ratio;
      }
    }
    return chunks;
  }

  /** The partial last chunk, or null when nothing is waiting. Samples in an unfinished window are dropped. */
  flush(): PcmChunk | null {
    return this.filled > 0 ? this.take() : null;
  }

  private emit(sample: number): PcmChunk | null {
    const value = toInt16(sample);
    this.out[this.filled] = value;
    const s = Math.max(-1, Math.min(1, sample));
    this.sumSquares += s * s;
    this.filled += 1;
    return this.filled === this.out.length ? this.take() : null;
  }

  private take(): PcmChunk {
    const level = Math.sqrt(this.sumSquares / this.filled);
    const pcm = encodeS16le(this.out, this.filled);
    this.filled = 0;
    this.sumSquares = 0;
    return { pcm, level };
  }
}
