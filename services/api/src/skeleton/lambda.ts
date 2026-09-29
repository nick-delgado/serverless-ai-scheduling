/**
 * Adapts `runChatTurn` to the Lambda response-streaming runtime behind an API Gateway REST API
 * (`responseTransferMode: STREAM`, ADR-007).
 */
import { finished } from "node:stream/promises";

import { runChatTurn, type ChatTurnDeps, type EventSink } from "./chat-turn";

/** The fields we read from the REST API Lambda proxy event (payload v1). */
export interface RestApiProxyEvent {
  body: string | null;
  isBase64Encoded?: boolean;
  requestContext: {
    requestId: string;
    /** Set by the Cognito User Pool authorizer: the verified ID token's claims. */
    authorizer?: { claims?: Record<string, string | undefined> } | null;
  };
}

export const NDJSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** An `EventSink` over the runtime's response stream. The status/headers prelude goes out on the first write. */
export function responseStreamSink(responseStream: awslambda.ResponseStream): EventSink {
  let stream = responseStream;
  return {
    open(statusCode) {
      stream = awslambda.HttpResponseStream.from(responseStream, { statusCode, headers: NDJSON_HEADERS });
    },
    write(chunk) {
      stream.write(chunk);
    },
    async end() {
      stream.end();
      try {
        await finished(stream);
      } catch {
        // The client went away mid-stream; there's nobody left to tell.
      }
    },
  };
}

export function chatStreamHandler(deps: ChatTurnDeps): awslambda.StreamifyHandler<RestApiProxyEvent> {
  return async (event, responseStream) => {
    await runChatTurn(
      {
        body: event.body,
        isBase64Encoded: event.isBase64Encoded,
        patientId: event.requestContext.authorizer?.claims?.sub,
        requestId: event.requestContext.requestId,
      },
      deps,
      responseStreamSink(responseStream),
    );
  };
}
