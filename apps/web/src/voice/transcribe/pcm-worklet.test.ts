/**
 * The worklet (S6-02, #29) in jsdom: the AudioWorklet globals it declares are stubbed, so the real
 * module registers its processor here and a test drives `process()` and `flush` like the audio thread.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESSOR_NAME, type WorkletMessage } from "./pcm";

interface Port {
  onmessage: ((event: { data: { type: "flush" } }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}
interface Processor {
  port: Port;
  process(inputs: Float32Array[][]): boolean;
}

const registered = new Map<string, new (options: unknown) => Processor>();
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(async () => {
  scope.sampleRate = 48_000;
  scope.registerProcessor = (name: string, ctor: new (options: unknown) => Processor) =>
    registered.set(name, ctor);
  scope.AudioWorkletProcessor = class {
    port: Port = { onmessage: null, postMessage: vi.fn() };
  };
  await import("./pcm-worklet");
});

afterAll(() => {
  delete scope.sampleRate;
  delete scope.registerProcessor;
  delete scope.AudioWorkletProcessor;
});

let processor: Processor;
const posted = () => processor.port.postMessage.mock.calls.map(([message]) => message as WorkletMessage);

beforeEach(() => {
  const Ctor = registered.get(PROCESSOR_NAME);
  if (!Ctor) throw new Error("not registered");
  processor = new Ctor({ processorOptions: { targetRate: 16_000, chunkSamples: 2 } });
});

describe("the pcm-capture worklet", () => {
  it("registers under the name the page uses", () => {
    expect([...registered.keys()]).toEqual([PROCESSOR_NAME]);
  });

  it("downsamples the context's samples and posts each chunk, transferring its buffer", () => {
    expect(processor.process([[Float32Array.from([0.3, 0.3, 0.3, 0.6, 0.6, 0.6])]])).toBe(true);
    const [message] = posted();
    expect(message).toMatchObject({ type: "chunk" });
    expect(message?.pcm?.byteLength).toBe(4);
    expect(processor.port.postMessage.mock.calls[0]?.[1]).toEqual([message?.pcm]);
  });

  it("keeps running with no input connected", () => {
    expect(processor.process([])).toBe(true);
    expect(posted()).toEqual([]);
  });

  it("answers flush with the partial last chunk, then stops", () => {
    processor.process([[Float32Array.from([0.3, 0.3, 0.3])]]);
    processor.port.onmessage?.({ data: { type: "flush" } });
    const [message] = posted();
    expect(message).toMatchObject({ type: "flushed" });
    expect(message?.pcm?.byteLength).toBe(2);
    expect(processor.process([[new Float32Array(3)]])).toBe(false);
  });

  it("answers flush with no chunk when nothing is waiting", () => {
    processor.port.onmessage?.({ data: { type: "flush" } });
    expect(posted()).toEqual([{ type: "flushed", pcm: null, level: 0 }]);
    expect(processor.port.postMessage.mock.calls[0]?.[1]).toEqual([]);
  });
});
