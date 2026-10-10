/**
 * The default Transcriber, #29's real-or-mock factory (r1/Q-2 (a), r1/A-3): the RealTranscriber in a
 * build with the Identity Pool ID, the mock on the dev server on the Cognito mock, none elsewhere.
 */
import { renderHook } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getAwsCredentials } from "../auth/session";
import { MockTranscriber } from "./MockTranscriber";
import { RealTranscriber } from "./transcribe/RealTranscriber";
import { defaultTranscriber } from "./TranscriberContext";

afterEach(() => vi.unstubAllEnvs());

/** A deployed build's IDs (synthetic). */
function stubDeployedBuild(identityPoolId = "eu-west-2:00000000-0000-4000-8000-000000000029") {
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_USER_POOL_ID", "eu-west-2_Pool");
  vi.stubEnv("VITE_SPA_CLIENT_ID", "client");
  vi.stubEnv("VITE_IDENTITY_POOL_ID", identityPoolId);
}

describe("defaultTranscriber", () => {
  it("is the RealTranscriber in a build with the Identity Pool ID, in the pool's region, with voice's credentials", () => {
    stubDeployedBuild();
    const transcriber = defaultTranscriber();
    expect(transcriber).toBeInstanceOf(RealTranscriber);
    const { options } = transcriber as RealTranscriber;
    expect(options.region).toBe("eu-west-2");
    expect(options.getCredentials).toBe(getAwsCredentials);
    expect(options.observe).toBeUndefined();
  });

  it("is the MockTranscriber, with the dev delays, on the dev server", () => {
    vi.stubEnv("DEV", true);
    const transcriber = defaultTranscriber();
    expect(transcriber).toBeInstanceOf(MockTranscriber);
    // Literal: a 0.3 s "permission prompt", then the transcript 1 s after Send.
    expect((transcriber as MockTranscriber).options).toEqual({ startDelayMs: 300, delayMs: 1000 });
  });

  it("is the RealTranscriber on a dev server with all three IDs", () => {
    stubDeployedBuild();
    vi.stubEnv("DEV", true);
    expect(defaultTranscriber()).toBeInstanceOf(RealTranscriber);
  });

  it("is none on a dev server on real Cognito without the Identity Pool ID (no mock transcript to the real API)", () => {
    stubDeployedBuild("");
    vi.stubEnv("DEV", true);
    expect(defaultTranscriber()).toBeNull();
  });

  it("is the mock on the dev server's Cognito mock even with an Identity Pool ID (its tokens can't be exchanged)", () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_IDENTITY_POOL_ID", "us-east-1:00000000-0000-4000-8000-000000000029");
    expect(defaultTranscriber()).toBeInstanceOf(MockTranscriber);
  });

  it("is none in a production build without the Identity Pool ID, so the mic shows disabled", () => {
    stubDeployedBuild("");
    expect(defaultTranscriber()).toBeNull();
  });
});

describe("TranscriberContext's default (no Provider, as ChatPage renders it)", () => {
  /** The context default is read once at module load, so load the module afresh under the stubbed env. */
  async function contextDefault() {
    vi.resetModules();
    const fresh = await import("./TranscriberContext");
    const mockModule = await import("./MockTranscriber");
    const realModule = await import("./transcribe/RealTranscriber");
    const { result } = renderHook(() => useContext(fresh.TranscriberContext));
    return {
      value: result.current,
      MockClass: mockModule.MockTranscriber,
      RealClass: realModule.RealTranscriber,
    };
  }

  it("is the RealTranscriber in a deployed build, built without touching audio", async () => {
    stubDeployedBuild();
    const { value, RealClass } = await contextDefault();
    expect(value).toBeInstanceOf(RealClass);
  });

  it("is the dev mock on the dev server", async () => {
    vi.stubEnv("DEV", true);
    const { value, MockClass } = await contextDefault();
    expect(value).toBeInstanceOf(MockClass);
  });

  it("is null in a production build without the Identity Pool ID", async () => {
    vi.stubEnv("DEV", false);
    const { value } = await contextDefault();
    expect(value).toBeNull();
  });

  it("gets a timing observer in a VITE_VOICE_TIMING=1 build", async () => {
    stubDeployedBuild();
    vi.stubEnv("VITE_VOICE_TIMING", "1");
    const { value } = await contextDefault();
    expect((value as RealTranscriber).options.observe).toBeTypeOf("function");
  });
});
