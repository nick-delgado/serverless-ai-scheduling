/** The default Transcriber (#28, A-3): the mock on the dev server, none in production builds. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockTranscriber } from "./MockTranscriber";
import { defaultTranscriber, DEV_MOCK_OPTIONS } from "./TranscriberContext";

afterEach(() => vi.unstubAllEnvs());

describe("defaultTranscriber", () => {
  it("is the MockTranscriber, with the dev delays, on the dev server", () => {
    vi.stubEnv("DEV", true);
    const transcriber = defaultTranscriber();
    expect(transcriber).toBeInstanceOf(MockTranscriber);
    expect((transcriber as MockTranscriber).options).toEqual(DEV_MOCK_OPTIONS);
  });

  it("is none in a production build, so the mic shows disabled", () => {
    vi.stubEnv("DEV", false);
    expect(defaultTranscriber()).toBeNull();
  });
});
