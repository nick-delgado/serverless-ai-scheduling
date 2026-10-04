/** The MockTranscriber's options (S6-01, #28), each on its own. Fake time throughout. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeTime } from "../chat/testUtils";
import { MOCK_LEVELS, MockTranscriber, SAMPLE_TRANSCRIPT } from "./MockTranscriber";
import { TranscriberError } from "./transcriber";

beforeEach(() => fakeTime());
afterEach(() => vi.useRealTimers());

/** Settle a promise's state without awaiting it forever. */
async function settled<T>(
  promise: Promise<T>,
): Promise<{ state: "pending" | "resolved" | "rejected"; value?: unknown }> {
  const result: { state: "pending" | "resolved" | "rejected"; value?: unknown } = { state: "pending" };
  promise.then(
    (value) => Object.assign(result, { state: "resolved", value }),
    (error: unknown) => Object.assign(result, { state: "rejected", value: error }),
  );
  await vi.advanceTimersByTimeAsync(0);
  return result;
}

describe("MockTranscriber", () => {
  it("resolves stop() with the sample transcript by default, and records the session", async () => {
    const mock = new MockTranscriber();
    const session = await mock.start();
    expect(mock.sessions).toEqual([{ state: "recording" }]);
    await expect(session.stop()).resolves.toBe(SAMPLE_TRANSCRIPT);
    expect(mock.sessions).toEqual([{ state: "stopped" }]);
    expect(mock.starts).toBe(1);
  });

  it("resolves stop() with the configured transcript after the delay", async () => {
    const session = await new MockTranscriber({ transcript: "Hello", delayMs: 1_000 }).start();
    const stop = session.stop();
    await vi.advanceTimersByTimeAsync(999);
    expect((await settled(stop)).state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(stop).resolves.toBe("Hello");
  });

  it("waits startDelayMs before start() settles", async () => {
    const start = new MockTranscriber({ startDelayMs: 300 }).start();
    await vi.advanceTimersByTimeAsync(299);
    expect((await settled(start)).state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect((await settled(start)).state).toBe("resolved");
  });

  it.each([
    [{ denied: true }, "denied"],
    [{ unavailable: true }, "unavailable"],
    [{ error: "start" as const }, "failed"],
  ])("start() with %o rejects with a %s TranscriberError", async (options, kind) => {
    const mock = new MockTranscriber(options);
    const error: unknown = await mock.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscriberError);
    expect((error as TranscriberError).kind).toBe(kind);
    expect(mock.sessions).toEqual([]);
  });

  it("neverFinal: stop() never settles", async () => {
    const session = await new MockTranscriber({ neverFinal: true }).start();
    const stop = session.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await settled(stop)).state).toBe("pending");
  });

  it("error: stop rejects stop() with failed", async () => {
    const session = await new MockTranscriber({ error: "stop" }).start();
    await expect(session.stop()).rejects.toMatchObject({ kind: "failed" });
  });

  it("error: recording calls onError after errorAfterMs and stops the levels", async () => {
    const onError = vi.fn();
    const onLevel = vi.fn();
    await new MockTranscriber({ error: "recording", errorAfterMs: 500 }).start({ onError, onLevel });
    await vi.advanceTimersByTimeAsync(499);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "failed" }));
    const levels = onLevel.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onLevel).toHaveBeenCalledTimes(levels);
  });

  it("error: recording doesn't fire after cancel", async () => {
    const onError = vi.fn();
    const session = await new MockTranscriber({ error: "recording", errorAfterMs: 500 }).start({ onError });
    session.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports levels every levelIntervalMs, cycling MOCK_LEVELS, until stop", async () => {
    const onLevel = vi.fn();
    const session = await new MockTranscriber({ levelIntervalMs: 50 }).start({ onLevel });
    await vi.advanceTimersByTimeAsync(50 * (MOCK_LEVELS.length + 1));
    expect(onLevel.mock.calls.map(([level]) => level as number)).toEqual([...MOCK_LEVELS, MOCK_LEVELS[0]]);
    void session.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(onLevel).toHaveBeenCalledTimes(MOCK_LEVELS.length + 1);
  });

  it("reports levels every 100 ms by default, and cancel stops them", async () => {
    const onLevel = vi.fn();
    const mock = new MockTranscriber();
    const session = await mock.start({ onLevel });
    await vi.advanceTimersByTimeAsync(100);
    expect(onLevel).toHaveBeenCalledOnce();
    session.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(onLevel).toHaveBeenCalledOnce();
    expect(mock.sessions).toEqual([{ state: "cancelled" }]);
  });

  it("reads options at each start(), so a test can change them between recordings", async () => {
    const mock = new MockTranscriber({ denied: true });
    await expect(mock.start()).rejects.toBeInstanceOf(TranscriberError);
    mock.options = {};
    await expect(mock.start()).resolves.toBeDefined();
  });
});
