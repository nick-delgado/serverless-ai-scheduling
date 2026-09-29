/**
 * The `awslambda` global that the Node.js Lambda runtime injects for response streaming.
 * It isn't an npm module, so there is nothing to import; these declarations cover the parts we use.
 * https://docs.aws.amazon.com/lambda/latest/dg/config-rs-write-functions.html
 */
import type { Writable } from "node:stream";

declare global {
  namespace awslambda {
    /** Status and headers for an HTTP (API Gateway / function URL) streaming response. */
    interface HttpResponseMetadata {
      statusCode: number;
      headers?: Record<string, string>;
      cookies?: string[];
    }

    /** The runtime's response stream: a Writable whose first write is preceded by the metadata prelude. */
    type ResponseStream = Writable;

    type StreamifyHandler<TEvent> = (
      event: TEvent,
      responseStream: ResponseStream,
      context: unknown,
    ) => Promise<void>;

    /** Marks a handler as streaming; the runtime then invokes it with a writable response stream. */
    function streamifyResponse<TEvent>(handler: StreamifyHandler<TEvent>): StreamifyHandler<TEvent>;

    const HttpResponseStream: {
      /** Wraps the stream so the status/headers prelude is written before the first body byte. */
      from(responseStream: ResponseStream, metadata: HttpResponseMetadata): ResponseStream;
    };
  }
}
