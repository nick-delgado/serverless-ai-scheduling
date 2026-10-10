/** Downsampling and s16le encoding (S6-02, #29; r1/A-6), the pure half of the capture worklet. */
import { describe, expect, it } from "vitest";

import { CHUNK_SAMPLES, Downsampler, encodeS16le, outputRate, TARGET_RATE, toInt16 } from "./pcm";

/** A chunk's samples, read back as little-endian int16. */
function samples(pcm: ArrayBuffer): number[] {
  const view = new DataView(pcm);
  return Array.from({ length: pcm.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
}

describe("toInt16", () => {
  it("maps -1..1 onto the full int16 range, clamping beyond it", () => {
    expect([-1, 1, 0, 0.5, -0.5, 2, -2].map(toInt16)).toEqual([
      -32768, 32767, 0, 16384, -16384, 32767, -32768,
    ]);
  });
});

describe("encodeS16le", () => {
  it("writes little-endian bytes, only the first `length` samples", () => {
    const bytes = new Uint8Array(encodeS16le(Int16Array.from([0x0102, -2, 7]), 2));
    expect(Array.from(bytes)).toEqual([0x02, 0x01, 0xfe, 0xff]);
  });
});

describe("Downsampler", () => {
  it("is 16 kHz, 1600 samples (100 ms) per chunk, as ADR-006 keeps", () => {
    expect([TARGET_RATE, CHUNK_SAMPLES]).toEqual([16_000, 1_600]);
  });

  it("48 kHz → 16 kHz: each output sample is the mean of three inputs", () => {
    const ds = new Downsampler(48_000, 16_000, 2);
    const [chunk] = ds.push(Float32Array.from([0.1, 0.2, 0.3, -0.5, -0.5, -0.5]));
    expect(samples(chunk?.pcm ?? new ArrayBuffer(0))).toEqual([toInt16(0.2), toInt16(-0.5)]);
  });

  it("emits one 3200-byte chunk per 100 ms of 48 kHz input, whatever the block size", () => {
    const ds = new Downsampler(48_000);
    const chunks = Array.from({ length: 37 }, () => ds.push(new Float32Array(128).fill(0.25))).flat();
    // 37 × 128 = 4736 input samples → 1578 output samples: not a full chunk yet.
    expect(chunks).toEqual([]);
    const more = Array.from({ length: 1 }, () => ds.push(new Float32Array(128).fill(0.25))).flat();
    expect(more).toHaveLength(1);
    expect(more[0]?.pcm.byteLength).toBe(3200);
  });

  it("handles a non-integer ratio: 44.1 kHz for one second gives 16000 samples (± the unfinished window)", () => {
    const ds = new Downsampler(44_100);
    const chunks = ds.push(new Float32Array(44_100));
    const rest = ds.flush();
    const total = chunks.reduce((n, c) => n + c.pcm.byteLength / 2, 0) + (rest ? rest.pcm.byteLength / 2 : 0);
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(1);
  });

  it("reports each chunk's RMS level", () => {
    const ds = new Downsampler(16_000, 16_000, 4);
    const [chunk] = ds.push(Float32Array.from([0.5, -0.5, 0.5, -0.5]));
    expect(chunk?.level).toBeCloseTo(0.5);
    const [loud] = ds.push(Float32Array.from([2, 2, 2, 2]));
    expect(loud?.level).toBe(1);
  });

  it("flush() returns the partial last chunk once, then null", () => {
    const ds = new Downsampler(16_000, 16_000, 4);
    ds.push(Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.25]));
    const last = ds.flush();
    expect(samples(last?.pcm ?? new ArrayBuffer(0))).toEqual([toInt16(0.25)]);
    expect(ds.flush()).toBeNull();
  });

  it("doesn't upsample a slower input: it passes through at its own rate", () => {
    expect(outputRate(8_000)).toBe(8_000);
    expect(outputRate(48_000)).toBe(16_000);
    const ds = new Downsampler(8_000, 16_000, 3);
    expect(ds.push(Float32Array.from([0.1, 0.2, 0.3])).map((c) => samples(c.pcm))).toEqual([
      [toInt16(0.1), toInt16(0.2), toInt16(0.3)],
    ]);
  });
});
