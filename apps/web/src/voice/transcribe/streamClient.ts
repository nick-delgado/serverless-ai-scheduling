/**
 * The one module that imports `@aws-sdk/client-transcribe-streaming` (S6-02, #29). `RealTranscriber`
 * loads it with a dynamic `import()` the first time the mic is used, so the SDK (about 57 KiB gzip,
 * ADR-006) stays out of the entry chunk (r1/A-5; `build.test.ts` checks it).
 *
 * In the browser the client streams over a WebSocket on `/stream-transcription-websocket`, signed for
 * `transcribe:StartStreamTranscriptionWebSocket`, the Identity Pool role's one action (ADR-006).
 */
import {
  type StartStreamTranscriptionCommandInput,
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type TranscriptResultStream,
} from "@aws-sdk/client-transcribe-streaming";

import type { AwsCredentials } from "../../auth/authService";

export type StreamInput = Pick<
  StartStreamTranscriptionCommandInput,
  "LanguageCode" | "MediaEncoding" | "MediaSampleRateHertz" | "AudioStream"
>;

export interface StreamResponse {
  TranscriptResultStream?: AsyncIterable<TranscriptResultStream>;
}

/** What `RealTranscriber` needs from the SDK, so its tests can use a fake Transcribe client. */
export interface StreamClient {
  /** Open the stream; resolves with the response once the socket is up. */
  start(input: StreamInput): Promise<StreamResponse>;
  /** Close the socket and drop everything. */
  destroy(): void;
}

export type StreamClientFactory = (region: string, credentials: AwsCredentials) => StreamClient;

export const createStreamClient: StreamClientFactory = (region, credentials) => {
  const client = new TranscribeStreamingClient({ region, credentials });
  return {
    start: (input) => client.send(new StartStreamTranscriptionCommand(input)),
    destroy: () => client.destroy(),
  };
};
