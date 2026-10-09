/**
 * The browser end of capture (S6-02, #29) against stubbed Web Audio and `getUserMedia`: the order
 * the spike measured (resume, then addModule), the error kinds, and releasing the mic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TranscriberError } from "../transcriber";
import { createAudioContext, describeError, FLUSH_TIMEOUT_MS, micError, openMic } from "./mic";
import { PROCESSOR_NAME, type WorkletMessage } from "./pcm";

class FakeNode {
  static last: FakeNode | undefined;
  readonly port = {
    onmessage: null as ((event: { data: WorkletMessage }) => void) | null,
    postMessage: vi.fn(),
  };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  constructor(
    readonly ctx: unknown,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    FakeNode.last = this;
  }
}

const scope = globalThis as unknown as Record<string, unknown>;
let log: string[];
let track: EventTarget & { stop: ReturnType<typeof vi.fn> };
let getUserMedia: ReturnType<typeof vi.fn>;
let source: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };

function fakeContext(sampleRate = 48_000) {
  return {
    sampleRate,
    destination: { fake: "destination" },
    resume: vi.fn(() => {
      log.push("resume");
      return Promise.resolve();
    }),
    audioWorklet: {
      addModule: vi.fn(() => {
        log.push("addModule");
        return Promise.resolve();
      }),
    },
    createMediaStreamSource: vi.fn(() => source),
    close: vi.fn(() => Promise.resolve()),
  };
}
type FakeContext = ReturnType<typeof fakeContext>;
const asContext = (ctx: FakeContext) => ctx as unknown as AudioContext;

const handlers = () => ({ onChunk: vi.fn(), onEnded: vi.fn() });

beforeEach(() => {
  log = [];
  track = Object.assign(new EventTarget(), { stop: vi.fn() });
  source = { connect: vi.fn(), disconnect: vi.fn() };
  const media = { getTracks: () => [track], getAudioTracks: () => [track] };
  getUserMedia = vi.fn(() => {
    log.push("getUserMedia");
    return Promise.resolve(media);
  });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  scope.AudioWorkletNode = FakeNode;
  FakeNode.last = undefined;
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "mediaDevices");
  delete scope.AudioWorkletNode;
  delete scope.AudioContext;
  vi.useRealTimers();
});

describe("createAudioContext", () => {
  it("makes a native-rate context (no sampleRate option)", () => {
    const made: unknown[][] = [];
    scope.AudioContext = class {
      readonly sampleRate = 48_000;
      constructor(...args: unknown[]) {
        made.push(args);
      }
    };
    expect(createAudioContext()).toBeInstanceOf(scope.AudioContext as new () => unknown);
    expect(made).toEqual([[]]);
  });

  it("is unavailable without Web Audio", () => {
    expect(() => createAudioContext()).toThrow(expect.objectContaining({ kind: "unavailable" }));
  });
});

describe("micError", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "unavailable"],
    ["OverconstrainedError", "unavailable"],
    ["NotReadableError", "failed"],
  ])("%s is %s", (name, kind) => {
    expect(micError(new DOMException("x", name))).toMatchObject({ kind });
  });

  it("is failed for something that isn't an Error", () => {
    expect(micError("weird")).toMatchObject({ kind: "failed", message: "Mic: unknown error" });
  });
});

describe("openMic", () => {
  it("asks for the mic, then resumes the context before adding the worklet", async () => {
    const ctx = fakeContext();
    await openMic(asContext(ctx), handlers());
    expect(log).toEqual(["getUserMedia", "resume", "addModule"]);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ channelCount: 1 }) });
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith(expect.stringContaining("pcm-worklet"));
  });

  it("wires mic → worklet (16 kHz, 1600-sample chunks) → destination, and reports 16 kHz", async () => {
    const ctx = fakeContext();
    const mic = await openMic(asContext(ctx), handlers());
    const node = FakeNode.last;
    expect(node?.name).toBe(PROCESSOR_NAME);
    expect(node?.options.processorOptions).toEqual({ targetRate: 16_000, chunkSamples: 1_600 });
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(node?.connect).toHaveBeenCalledWith(ctx.destination);
    expect(mic.sampleRate).toBe(16_000);
  });

  it("reports a slower context's own rate", async () => {
    const mic = await openMic(asContext(fakeContext(8_000)), handlers());
    expect(mic.sampleRate).toBe(8_000);
  });

  it("passes each chunk on as bytes, with its level", async () => {
    const h = handlers();
    await openMic(asContext(fakeContext()), h);
    FakeNode.last?.port.onmessage?.({ data: { type: "chunk", pcm: new ArrayBuffer(4), level: 0.3 } });
    expect(h.onChunk).toHaveBeenCalledWith(new Uint8Array(4), 0.3);
  });

  it("flush() asks the worklet, passes on its last chunk, and resolves when it answers", async () => {
    const h = handlers();
    const mic = await openMic(asContext(fakeContext()), h);
    const flushed = mic.flush();
    expect(FakeNode.last?.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
    FakeNode.last?.port.onmessage?.({ data: { type: "flushed", pcm: new ArrayBuffer(2), level: 0.1 } });
    await flushed;
    expect(h.onChunk).toHaveBeenCalledWith(new Uint8Array(2), 0.1);
  });

  it("flush() gives up on a worklet that doesn't answer", async () => {
    vi.useFakeTimers();
    const mic = await openMic(asContext(fakeContext()), handlers());
    const flushed = vi.fn();
    void mic.flush().then(flushed);
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS - 1);
    expect(flushed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toHaveBeenCalled();
  });

  it("reports the track ending", async () => {
    const h = handlers();
    await openMic(asContext(fakeContext()), h);
    track.dispatchEvent(new Event("ended"));
    expect(h.onEnded).toHaveBeenCalledTimes(1);
  });

  it("close() stops the tracks (the mic indicator goes off), disconnects and closes the context, once", async () => {
    const ctx = fakeContext();
    const mic = await openMic(asContext(ctx), handlers());
    await Promise.all([mic.close(), mic.close()]);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(source.disconnect).toHaveBeenCalled();
    expect(FakeNode.last?.disconnect).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it("is unavailable without mediaDevices (an insecure context), and closes the context", async () => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    const ctx = fakeContext();
    await expect(openMic(asContext(ctx), handlers())).rejects.toMatchObject({ kind: "unavailable" });
    expect(ctx.close).toHaveBeenCalled();
  });

  it("is unavailable without AudioWorklet", async () => {
    delete scope.AudioWorkletNode;
    await expect(openMic(asContext(fakeContext()), handlers())).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("is denied when permission is refused", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    const ctx = fakeContext();
    await expect(openMic(asContext(ctx), handlers())).rejects.toMatchObject({ kind: "denied" });
    expect(ctx.close).toHaveBeenCalled();
  });

  it("fails, stopping the mic and closing the context, when the worklet can't load", async () => {
    const ctx = fakeContext();
    ctx.audioWorklet.addModule.mockRejectedValueOnce(new Error("AbortError"));
    ctx.close.mockRejectedValueOnce(new Error("already closed"));
    const error: unknown = await openMic(asContext(ctx), handlers()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscriberError);
    expect(error).toMatchObject({ kind: "failed" });
    expect(track.stop).toHaveBeenCalled();
  });
});

describe("describeError", () => {
  it("names an Error, and stringifies anything else", () => {
    expect(describeError(new RangeError("bad"))).toBe("RangeError: bad");
    expect(describeError(42)).toBe("42");
  });
});
