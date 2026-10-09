/** The SDK adapter (S6-02, #29) against a mocked `@aws-sdk/client-transcribe-streaming`. */
import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const clients: { config: unknown; send: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] =
    [];
  class TranscribeStreamingClient {
    send = vi.fn((command: unknown) => Promise.resolve({ command }));
    destroy = vi.fn();
    constructor(readonly config: unknown) {
      clients.push(this);
    }
  }
  class StartStreamTranscriptionCommand {
    constructor(readonly input: unknown) {}
  }
  return { clients, TranscribeStreamingClient, StartStreamTranscriptionCommand };
});

vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  TranscribeStreamingClient: sdk.TranscribeStreamingClient,
  StartStreamTranscriptionCommand: sdk.StartStreamTranscriptionCommand,
}));

import { FAKE_AWS_CREDENTIALS } from "../../auth/testing";
import { createStreamClient, type StreamInput } from "./streamClient";

describe("createStreamClient", () => {
  it("makes a client for the region and credentials, and starts the stream with StartStreamTranscription", async () => {
    const client = createStreamClient("us-east-1", FAKE_AWS_CREDENTIALS);
    expect(sdk.clients[0]?.config).toEqual({ region: "us-east-1", credentials: FAKE_AWS_CREDENTIALS });
    const input = {
      LanguageCode: "en-US",
      MediaEncoding: "pcm",
      MediaSampleRateHertz: 16_000,
    } as StreamInput;
    const response = (await client.start(input)) as unknown as { command: unknown };
    expect(response.command).toBeInstanceOf(sdk.StartStreamTranscriptionCommand);
    expect((response.command as { input: unknown }).input).toBe(input);
    client.destroy();
    expect(sdk.clients[0]?.destroy).toHaveBeenCalledTimes(1);
  });
});
