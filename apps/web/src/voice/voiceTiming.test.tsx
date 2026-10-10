/** The timing gate (#29 r2/Q-2 (a)): everything is off unless the build sets VITE_VOICE_TIMING=1. */
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
});

async function freshGate(flag: string | undefined) {
  if (flag !== undefined) vi.stubEnv("VITE_VOICE_TIMING", flag);
  vi.resetModules();
  return import("./voiceTiming");
}

describe("voiceTiming", () => {
  it.each([undefined, "0", "true"])(
    "is off with VITE_VOICE_TIMING=%s: no observer, no panel",
    async (flag) => {
      const gate = await freshGate(flag);
      expect(gate.observeTiming).toBeUndefined();
      expect(gate.TimingPanel).toBeNull();
    },
  );

  it("with VITE_VOICE_TIMING=1 loads the timing record and gives an observer per recording", async () => {
    const gate = await freshGate("1");
    expect(gate.TimingPanel).not.toBeNull();
    await vi.waitFor(() => expect(gate.observeTiming?.()).toBeDefined());
    expect(gate.observeTiming?.()).not.toBe(gate.observeTiming?.());
  });

  it("with VITE_VOICE_TIMING=1 the mic's VoiceInput shows the timing panel", async () => {
    vi.stubEnv("VITE_VOICE_TIMING", "1");
    vi.resetModules();
    const { VoiceInput } = await import("./VoiceInput");
    render(<VoiceInput onTranscript={() => true} responding={false} inputRef={createRef()} />);
    expect(await screen.findByText(/^Voice timing:/)).toBeInTheDocument();
  });
});
