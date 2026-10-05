/** The default Transcriber (#28, A-3): the mock on the dev server, none in production builds. */
import { renderHook } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockTranscriber } from "./MockTranscriber";
import { defaultTranscriber } from "./TranscriberContext";

afterEach(() => vi.unstubAllEnvs());

describe("defaultTranscriber", () => {
  it("is the MockTranscriber, with the dev delays, on the dev server", () => {
    vi.stubEnv("DEV", true);
    const transcriber = defaultTranscriber();
    expect(transcriber).toBeInstanceOf(MockTranscriber);
    // Literal: a 0.3 s "permission prompt", then the transcript 1 s after Send.
    expect((transcriber as MockTranscriber).options).toEqual({ startDelayMs: 300, delayMs: 1000 });
  });

  it("is none in a production build, so the mic shows disabled", () => {
    vi.stubEnv("DEV", false);
    expect(defaultTranscriber()).toBeNull();
  });
});

describe("TranscriberContext's default (no Provider, as ChatPage renders it)", () => {
  /** The context default is read once at module load, so load the module afresh under the stubbed env. */
  async function contextDefault(dev: boolean) {
    vi.stubEnv("DEV", dev);
    vi.resetModules();
    const fresh = await import("./TranscriberContext");
    const mockModule = await import("./MockTranscriber");
    const { result } = renderHook(() => useContext(fresh.TranscriberContext));
    return { value: result.current, MockClass: mockModule.MockTranscriber };
  }

  it("is the dev mock on the dev server", async () => {
    const { value, MockClass } = await contextDefault(true);
    expect(value).toBeInstanceOf(MockClass);
  });

  it("is null in a production build", async () => {
    const { value } = await contextDefault(false);
    expect(value).toBeNull();
  });
});
