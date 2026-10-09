/**
 * The real Transcriber against a fake Transcribe client and a fake mic (S6-02, #29): the order of
 * start-up, the held chunks, the end of audio (ADR-006 "For #29"), Cancel, errors while recording,
 * and the page becoming hidden (r2/Q-1 (a)).
 */
import type { TranscriptResultStream } from "@aws-sdk/client-transcribe-streaming";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FAKE_AWS_CREDENTIALS } from "../../auth/testing";
import { fakeTime } from "../../chat/testUtils";
import { TranscriberError } from "../transcriber";
import { FINAL_TIMEOUT_MS, useRecording } from "../useRecording";
import {
  identityPoolRegion,
  loadStreamClient,
  RealTranscriber,
  type StreamObserver,
} from "./RealTranscriber";
import { fakeMic, fakeTranscribe, settle } from "./testing";

const CTX = { fake: "AudioContext" } as unknown as AudioContext;

function setup(
  overrides: {
    credentials?: () => Promise<typeof FAKE_AWS_CREDENTIALS | undefined>;
    noResultStream?: boolean;
  } = {},
) {
  const transcribe = fakeTranscribe({ noResultStream: overrides.noResultStream });
  const mic = fakeMic();
  const log: string[] = [];
  const observer: StreamObserver = {
    recording: vi.fn(),
    send: vi.fn(),
    final: vi.fn(),
    end: vi.fn(),
  };
  const transcriber = new RealTranscriber({
    region: "us-east-1",
    getCredentials: vi.fn(() => {
      log.push("credentials");
      return (overrides.credentials ?? (() => Promise.resolve(FAKE_AWS_CREDENTIALS)))();
    }),
    loadClient: vi.fn(() => {
      log.push("sdk");
      return Promise.resolve(transcribe.factory);
    }),
    createAudioContext: vi.fn(() => {
      log.push("context");
      return CTX;
    }),
    openMic: vi.fn((ctx: AudioContext, handlers) => {
      log.push("mic");
      return mic.open(ctx, handlers);
    }),
    observe: () => observer,
  });
  const callbacks = { onLevel: vi.fn(), onError: vi.fn() };
  return { transcribe, mic, log, observer, transcriber, callbacks };
}

/** Started, with the stream open. */
async function recording(overrides?: Parameters<typeof setup>[0]) {
  const t = setup(overrides);
  const session = await t.transcriber.start(t.callbacks);
  await settle();
  return { ...t, session, client: t.transcribe.client() };
}

function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => vi.restoreAllMocks());

describe("RealTranscriber construction", () => {
  it("touches no browser API, fetches nothing and loads no SDK until start()", () => {
    const t = setup();
    expect(t.log).toEqual([]);
    expect(t.transcriber.options.region).toBe("us-east-1");
  });

  it("takes its region from the Identity Pool ID's prefix", () => {
    expect(identityPoolRegion("eu-west-2:00000000-0000-4000-8000-000000000000")).toBe("eu-west-2");
    expect(identityPoolRegion("no-region")).toBe("");
  });

  it("loads the SDK adapter lazily, as a factory", async () => {
    await expect(loadStreamClient()).resolves.toBeTypeOf("function");
  });
});

describe("start()", () => {
  it("creates the AudioContext first, before any await, then fetches and asks for the mic", () => {
    const t = setup();
    void t.transcriber.start(t.callbacks);
    expect(t.log[0]).toBe("context");
    expect(t.log).toEqual(["context", "sdk", "credentials", "mic"]);
  });

  it("opens the stream with the patient's credentials: en-US, PCM at the mic's rate", async () => {
    const { client, observer } = await recording();
    expect(client?.region).toBe("us-east-1");
    expect(client?.credentials).toBe(FAKE_AWS_CREDENTIALS);
    expect(client?.input).toMatchObject({
      LanguageCode: "en-US",
      MediaEncoding: "pcm",
      MediaSampleRateHertz: 16_000,
    });
    expect(observer.recording).toHaveBeenCalledTimes(1);
  });

  it("rejects with the mic's error and opens no stream", async () => {
    const t = setup();
    t.mic.open.mockRejectedValueOnce(new TranscriberError("denied"));
    await expect(t.transcriber.start(t.callbacks)).rejects.toMatchObject({ kind: "denied" });
    await settle();
    expect(t.transcribe.clients).toEqual([]);
  });

  it("holds chunks captured before the socket opens and sends them first, in order", async () => {
    let grant!: (credentials: typeof FAKE_AWS_CREDENTIALS) => void;
    const t = setup({ credentials: () => new Promise((resolve) => (grant = resolve)) });
    await t.transcriber.start(t.callbacks);
    t.mic.chunk(3200);
    t.mic.chunk(3198);
    await settle();
    expect(t.transcribe.clients).toEqual([]);
    grant(FAKE_AWS_CREDENTIALS);
    await settle();
    t.mic.chunk(3196);
    await settle();
    expect(t.transcribe.client()?.sizes()).toEqual([3200, 3198, 3196]);
  });

  it("reports levels while recording, not after Send", async () => {
    const { mic, session, callbacks } = await recording();
    mic.chunk(3200, 0.25);
    expect(callbacks.onLevel).toHaveBeenCalledWith(0.25);
    void session.stop();
    mic.chunk(3200, 0.75);
    expect(callbacks.onLevel).not.toHaveBeenCalledWith(0.75);
  });
});

describe("stop() (Send, or the 60 s auto-send)", () => {
  it("ends the audio with an empty AudioEvent and keeps the input open until Transcribe ends the stream", async () => {
    const { mic, session, client, observer } = await recording();
    mic.chunk(3200);
    const stopped = session.stop();
    await settle();
    expect(mic.mic.flush).toHaveBeenCalledTimes(1);
    expect(mic.mic.close).toHaveBeenCalled();
    expect(observer.send).toHaveBeenCalledTimes(1);
    expect(client?.sizes()).toEqual([3200, 0]);
    expect(client?.inputEnded).toBe(false);

    client?.result("Hi, this is", true);
    client?.result("Hi, this is Maria Santos.");
    client?.result("Can I see Doctor Lee? ");
    await settle();
    expect(client?.inputEnded).toBe(false);
    client?.end();
    await expect(stopped).resolves.toBe("Hi, this is Maria Santos. Can I see Doctor Lee?");
    await settle();
    expect(client?.inputEnded).toBe(true);
    expect(client?.destroyed).toBe(false);
    expect(observer.final).toHaveBeenCalledTimes(2);
    expect(observer.end).toHaveBeenCalledWith({
      status: "ok",
      transcript: "Hi, this is Maria Santos. Can I see Doctor Lee?",
    });
  });

  it("sends the worklet's last partial chunk before the empty event", async () => {
    const { mic, session, client } = await recording();
    vi.mocked(mic.mic.flush).mockImplementationOnce(() => {
      mic.chunk(640);
      return Promise.resolve();
    });
    void session.stop();
    await settle();
    expect(client?.sizes()).toEqual([640, 0]);
  });

  it("resolves with an empty transcript when no final result came", async () => {
    const { session, client } = await recording();
    const stopped = session.stop();
    client?.result("um", true);
    client?.end();
    await expect(stopped).resolves.toBe("");
  });

  it("rejects with failed when the stream errors after Send", async () => {
    const { session, client, observer } = await recording();
    const stopped = session.stop();
    client?.fail(Object.assign(new Error("Your request timed out"), { name: "BadRequestException" }));
    await expect(stopped).rejects.toMatchObject({ kind: "failed" });
    expect(observer.end).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", reason: "error" }));
  });

  it("treats an exception event in the response stream as an error", async () => {
    const { session, client } = await recording();
    const stopped = session.stop();
    // The SDK usually throws these; an exception member that arrives as an event is handled the same way.
    client?.event({
      LimitExceededException: { Message: "Too many streams" },
    } as unknown as TranscriptResultStream);
    await expect(stopped).rejects.toThrow(/LimitExceededException: Too many streams/);
  });

  it("takes the first alternative of each final, skipping events without results", async () => {
    const { session, client } = await recording();
    const stopped = session.stop();
    client?.event({ $unknown: ["SomethingNew", {}] } as unknown as TranscriptResultStream);
    client?.event({ TranscriptEvent: {} });
    client?.event({
      TranscriptEvent: {
        Transcript: {
          Results: [{ IsPartial: false, Alternatives: [{ Transcript: "Yes." }, { Transcript: "Yeah." }] }],
        },
      },
    });
    client?.event({ TranscriptEvent: { Transcript: { Results: [{ IsPartial: false, Alternatives: [] }] } } });
    client?.end();
    await expect(stopped).resolves.toBe("Yes.");
  });

  it("names an exception event that has no message", async () => {
    const { session, client } = await recording();
    const stopped = session.stop();
    client?.event({ InternalFailureException: {} } as unknown as TranscriptResultStream);
    await expect(stopped).rejects.toThrow(/InternalFailureException: InternalFailureException/);
  });

  it("rejects a second stop()", async () => {
    const { session } = await recording();
    void session.stop();
    await expect(session.stop()).rejects.toBeInstanceOf(TranscriberError);
  });
});

describe("cancel()", () => {
  it("closes the stream, ends the input, releases the mic and discards the transcript", async () => {
    const { session, client, mic, observer } = await recording();
    const stopped = session.stop();
    client?.result("Hi there.");
    await settle();
    session.cancel();
    await expect(stopped).rejects.toBeInstanceOf(TranscriberError);
    await settle();
    expect(client?.destroyed).toBe(true);
    expect(client?.inputEnded).toBe(true);
    expect(mic.mic.close).toHaveBeenCalled();
    expect(observer.end).toHaveBeenCalledWith({ status: "cancelled", afterSend: true });
    expect(observer.end).toHaveBeenCalledTimes(1);
  });

  it("while recording ends the input without the end-of-audio event, and is idempotent", async () => {
    const { session, client, mic, observer, callbacks } = await recording();
    mic.chunk(3200);
    session.cancel();
    session.cancel();
    await settle();
    expect(client?.sizes()).toEqual([3200]);
    expect(client?.inputEnded).toBe(true);
    expect(client?.destroy).toHaveBeenCalledTimes(1);
    expect(observer.end).toHaveBeenCalledWith({ status: "cancelled", afterSend: false });
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("discards audio the mic delivers after Cancel", async () => {
    const { session, client, mic, callbacks } = await recording();
    session.cancel();
    mic.chunk(3200, 0.9);
    await settle();
    expect(client?.sizes()).toEqual([]);
    expect(callbacks.onLevel).not.toHaveBeenCalled();
  });

  it("before the stream opened: no client is ever made", async () => {
    let grant!: (credentials: typeof FAKE_AWS_CREDENTIALS) => void;
    const t = setup({ credentials: () => new Promise((resolve) => (grant = resolve)) });
    const session = await t.transcriber.start(t.callbacks);
    session.cancel();
    grant(FAKE_AWS_CREDENTIALS);
    await settle();
    expect(t.transcribe.clients).toEqual([]);
    expect(t.mic.mic.close).toHaveBeenCalled();
  });

  it("after stop() has settled does nothing more", async () => {
    const { session, client, observer } = await recording();
    const stopped = session.stop();
    client?.end();
    await stopped;
    session.cancel();
    expect(observer.end).toHaveBeenCalledTimes(1);
  });
});

describe("errors while recording reach the overlay through onError", () => {
  it.each([
    [
      "the stream errors",
      (c: Awaited<ReturnType<typeof recording>>) => c.client?.fail(new Error("WebSocket error")),
      "error",
    ],
    [
      "the stream ends before Send",
      (c: Awaited<ReturnType<typeof recording>>) => c.client?.end(),
      "closed-early",
    ],
    ["the mic track ends", (c: Awaited<ReturnType<typeof recording>>) => c.mic.endTrack(), "mic-ended"],
  ] as const)("%s: failed, once, and everything is released", async (_, cause, reason) => {
    const c = await recording();
    cause(c);
    await settle();
    expect(c.callbacks.onError).toHaveBeenCalledTimes(1);
    expect(c.callbacks.onError.mock.calls[0]?.[0]).toMatchObject({ kind: "failed" });
    expect(c.mic.mic.close).toHaveBeenCalled();
    expect(c.client?.destroyed).toBe(true);
    expect(c.observer.end).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", reason }));
    await expect(c.session.stop()).rejects.toMatchObject({ kind: "failed" });
  });

  it("a response with no result stream ends it before Send: failed", async () => {
    const c = await recording({ noResultStream: true });
    expect(c.callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed" }));
    expect(c.observer.end).toHaveBeenCalledWith(expect.objectContaining({ reason: "closed-early" }));
  });

  it("no AWS credentials (signed out, no Identity Pool): failed", async () => {
    const c = await recording({ credentials: () => Promise.resolve(undefined) });
    expect(c.callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed" }));
    expect(c.transcribe.clients).toEqual([]);
  });

  it("Cognito can't issue credentials: failed", async () => {
    const c = await recording({ credentials: () => Promise.reject(new Error("Identity is unavailable")) });
    expect(c.callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed" }));
  });
});

describe("the page becoming hidden (r2/Q-1 (a))", () => {
  it("while recording: onError with failed, the mic stopped and the stream closed", async () => {
    const { callbacks, mic, client } = await recording();
    setVisibility("hidden");
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onError.mock.calls[0]?.[0]).toMatchObject({ kind: "failed" });
    expect(mic.mic.close).toHaveBeenCalled();
    expect(client?.destroyed).toBe(true);
    setVisibility("visible");
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
  });

  it("becoming visible is not an error", async () => {
    const { callbacks } = await recording();
    setVisibility("visible");
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("after Send (Transcribing…) is not an error", async () => {
    const { session, callbacks, client } = await recording();
    const stopped = session.stop();
    setVisibility("hidden");
    client?.result("Thanks.");
    client?.end();
    await expect(stopped).resolves.toBe("Thanks.");
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("during start-up (the permission prompt) is not an error", async () => {
    const t = setup();
    const started = t.transcriber.start(t.callbacks);
    setVisibility("hidden");
    await started;
    expect(t.callbacks.onError).not.toHaveBeenCalled();
  });
});

describe("with #28's overlay (useRecording)", () => {
  afterEach(() => vi.useRealTimers());

  it("closes the stream when the overlay gives up 10 s after Send with no final result", async () => {
    const t = setup();
    fakeTime();
    const { result } = renderHook(() =>
      useRecording({ transcriber: t.transcriber, onTranscript: () => true }),
    );
    act(() => result.current.record());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.phase).toEqual({ name: "recording" });
    const client = t.transcribe.client();

    act(() => result.current.send());
    await act(() => vi.advanceTimersByTimeAsync(FINAL_TIMEOUT_MS - 1));
    expect(result.current.phase).toEqual({ name: "transcribing" });
    expect(client?.destroyed).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.phase).toEqual({ name: "failed" });
    expect(client?.destroyed).toBe(true);
    expect(client?.inputEnded).toBe(true);
    expect(t.mic.mic.close).toHaveBeenCalled();
  });
});
