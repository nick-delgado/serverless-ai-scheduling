/**
 * The chat page's API client: `POST /api/session` and `POST /api/chat` (ADR-007).
 *
 * Auth is injected: `getToken` returns the Cognito ID token, sent raw as `Authorization` (what the
 * REST API's Cognito authorizer reads). Without a getter, or when it returns nothing, no header is
 * sent, which is what the mock API expects. The app's `/chat` route passes the login's token getter
 * (`src/app/routes.tsx`, #29).
 *
 * Failures are typed so the error and retry UI (#27) can tell them apart:
 * - `ChatHttpError`: a non-2xx response that carried no stream `error` event (e.g. API Gateway's 401);
 * - `ChatProtocolError` (streamClient.ts): a body that broke the contract (a session body that isn't
 *   JSON or has the wrong shape, or a chat stream that breaks ADR-007);
 * - anything else `fetch` or the reader throws (network failure, abort) passes through unchanged.
 * A 4xx/5xx whose body is a stream `error` event (400, 429, 503) is not thrown: the event is delivered.
 */
import {
  type ChatRequest,
  type ChatStreamEvent,
  parseStreamEventLine,
  SessionResponse,
} from "@sched/contracts";

import { ChatProtocolError, readChatStream } from "./streamClient";

export class ChatHttpError extends Error {
  override readonly name = "ChatHttpError";
  constructor(readonly status: number) {
    super(`The server answered ${String(status)}.`);
  }
}

export interface ChatApiOptions {
  /** Resolves to the ID token to send, or `undefined` to send none. */
  getToken?: () => Promise<string | undefined>;
}

export interface ChatApi {
  getSession(signal?: AbortSignal): Promise<SessionResponse>;
  /** Streams one turn. Resolves with every event once the stream ends (the last is `done` or `error`). */
  sendChat(
    request: ChatRequest,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<ChatStreamEvent[]>;
}

/** A non-2xx body that is a single stream `error` event (ADR-007's 400/429/503), or `undefined`. */
function errorEventFrom(body: string): ChatStreamEvent | undefined {
  try {
    const event = parseStreamEventLine(body.trim());
    return event.type === "error" ? event : undefined;
  } catch {
    return undefined;
  }
}

export function createChatApi(options: ChatApiOptions = {}): ChatApi {
  async function headers(): Promise<Headers> {
    const result = new Headers();
    const token = await options.getToken?.();
    if (token) result.set("Authorization", token);
    return result;
  }

  return {
    async getSession(signal) {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: await headers(),
        signal,
      });
      if (!response.ok) throw new ChatHttpError(response.status);
      // A body that isn't JSON and one of the wrong shape fail the same way.
      try {
        return SessionResponse.parse(await response.json());
      } catch (cause) {
        throw new ChatProtocolError("The session response couldn't be read.", { cause });
      }
    },

    async sendChat(request, onEvent, signal) {
      const requestHeaders = await headers();
      requestHeaders.set("Content-Type", "application/json");
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) {
        const event = errorEventFrom(await response.text());
        if (!event) throw new ChatHttpError(response.status);
        onEvent(event);
        return [event];
      }
      if (!response.body) throw new ChatProtocolError("The chat response had no body.");
      return readChatStream(response.body, onEvent);
    },
  };
}
