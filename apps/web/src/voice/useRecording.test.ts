/** `useRecording` on its own (#28): calls that the overlay's buttons can't reach in order. */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeTime } from "../chat/testUtils";
import { MockTranscriber } from "./MockTranscriber";
import { useRecording } from "./useRecording";

beforeEach(() => fakeTime());
afterEach(() => vi.useRealTimers());

describe("useRecording", () => {
  it("send() after close() does nothing: no phase, and the session stays cancelled", async () => {
    const transcriber = new MockTranscriber({ neverFinal: true });
    const { result } = renderHook(() => useRecording({ transcriber, onTranscript: () => true }));
    act(() => result.current.record());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.phase).toEqual({ name: "recording" });

    act(() => result.current.close());
    act(() => result.current.send());
    expect(result.current.phase).toBeNull();
    expect(transcriber.sessions[0]?.state).toBe("cancelled");
  });
});
