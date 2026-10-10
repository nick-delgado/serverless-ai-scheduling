/**
 * Test doubles for `RealTranscriber` (S6-02, #29): a fake Transcribe client that records the audio it
 * reads and answers with the results a test feeds it, and a fake mic. No browser audio, no network.
 */
import type { AudioStream, TranscriptResultStream } from "@aws-sdk/client-transcribe-streaming";
import { vi } from "vitest";

import type { AwsCredentials } from "../../auth/authService";
import type { Mic, MicHandlers } from "./mic";
import type { StreamClient, StreamClientFactory, StreamInput, StreamResponse } from "./streamClient";

/** Let pending promise callbacks and zero-delay timers run. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A fake Transcribe Streaming client, one per stream. */
export class FakeStreamClient implements StreamClient {
  input: StreamInput | undefined;
  /** Every `AudioChunk` the client read from the input, in order (an empty one ends the audio). */
  readonly chunks: Uint8Array[] = [];
  /** The input iterable has ended (the real SDK then closes the socket). */
  inputEnded = false;
  destroyed = false;
  private readonly events: (TranscriptResultStream | Error | "end")[] = [];
  private wake: (() => void) | undefined;

  constructor(
    readonly region: string,
    readonly credentials: AwsCredentials,
  ) {}

  start = vi.fn((input: StreamInput): Promise<StreamResponse> => {
    this.input = input;
    void this.read(input.AudioStream as AsyncIterable<AudioStream>);
    return Promise.resolve({ TranscriptResultStream: this.responses() });
  });

  destroy = vi.fn(() => {
    this.destroyed = true;
    this.push(new Error("socket closed by destroy()"));
  });

  /** Sizes of the chunks read so far: 0 is the empty end-of-audio event. */
  sizes(): number[] {
    return this.chunks.map((chunk) => chunk.byteLength);
  }

  result(text: string, partial = false): void {
    this.push({
      TranscriptEvent: {
        Transcript: { Results: [{ IsPartial: partial, Alternatives: [{ Transcript: text }] }] },
      },
    });
  }

  event(event: TranscriptResultStream): void {
    this.push(event);
  }

  /** Transcribe ends the response stream. */
  end(): void {
    this.push("end");
  }

  fail(error: Error): void {
    this.push(error);
  }

  private push(item: TranscriptResultStream | Error | "end"): void {
    this.events.push(item);
    this.wake?.();
  }

  private async *responses(): AsyncGenerator<TranscriptResultStream> {
    for (;;) {
      if (this.events.length === 0) await new Promise<void>((resolve) => (this.wake = resolve));
      const item = this.events.shift();
      if (item === "end") return;
      if (item instanceof Error) throw item;
      if (item) yield item;
    }
  }

  private async read(stream: AsyncIterable<AudioStream>): Promise<void> {
    for await (const event of stream)
      if (event.AudioEvent?.AudioChunk) this.chunks.push(event.AudioEvent.AudioChunk);
    this.inputEnded = true;
  }
}

/** A factory that keeps every client it made; `noResultStream` makes each answer without a result stream. */
export function fakeTranscribe({ noResultStream = false } = {}) {
  const clients: FakeStreamClient[] = [];
  const factory: StreamClientFactory = (region, credentials) => {
    const client = new FakeStreamClient(region, credentials);
    if (noResultStream) client.start.mockResolvedValueOnce({});
    clients.push(client);
    return client;
  };
  return { clients, factory, client: () => clients[0] };
}

/** A fake mic: the test sends chunks and ends the track through `handlers`. */
export function fakeMic(sampleRate = 16_000) {
  const state: { handlers?: MicHandlers } = {};
  const mic: Mic = {
    sampleRate,
    flush: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const open = vi.fn((_ctx: AudioContext, handlers: MicHandlers) => {
    state.handlers = handlers;
    return Promise.resolve(mic);
  });
  return {
    mic,
    open,
    chunk: (bytes: number, level = 0.5) => state.handlers?.onChunk(new Uint8Array(bytes), level),
    endTrack: () => state.handlers?.onEnded(),
  };
}
