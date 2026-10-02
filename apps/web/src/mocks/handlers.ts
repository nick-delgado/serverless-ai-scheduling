/**
 * MSW handlers that stand in for the API (S5-01, #24), so UI work never waits on it. Bodies and
 * events are validated against @sched/contracts on the way out, so the mock can't drift from the
 * real shapes without a test failing.
 *
 * - `POST /api/session`: a `SessionResponse`.
 * - `POST /api/chat`: `ChatStreamEvent`s as NDJSON, ending in `done` or `error` (ADR-007).
 */
import {
  type ApiError,
  ChatRequest,
  type ChatStreamEvent,
  encodeStreamEvent,
  messageIdForSeq,
  SessionResponse,
} from "@sched/contracts";
import { http, HttpResponse } from "msw";

import { REPLIES, RESTORE_CONVERSATION_ID, SAMPLE_USAGE, SESSIONS } from "./fixtures";
import type { MockApiOptions } from "./options";

export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** API Gateway's own 401 body (the authorizer rejects the request before any Lambda runs). */
function unauthorized(): Response {
  return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
}

function ndjson(events: readonly ChatStreamEvent[], status: number): Response {
  return new HttpResponse(events.map(encodeStreamEvent).join(""), {
    status,
    headers: { "Content-Type": NDJSON_CONTENT_TYPE },
  });
}

/**
 * A 200 NDJSON stream: the first event right away (the caller has already waited `firstEventMs`, so
 * headers and first event arrive together), then one event per `intervalMs`. Stops early if the
 * client aborts.
 */
function ndjsonStream(events: readonly ChatStreamEvent[], intervalMs: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next > 0) await sleep(intervalMs);
      const event = events[next];
      if (signal.aborted || event === undefined) {
        controller.close();
        return;
      }
      next += 1;
      controller.enqueue(encoder.encode(encodeStreamEvent(event)));
      if (next === events.length) controller.close();
    },
  });
  return new HttpResponse(body, { status: 200, headers: { "Content-Type": NDJSON_CONTENT_TYPE } });
}

function errorEvent(code: "BAD_REQUEST" | "RATE_LIMITED" | "AGENT_UNAVAILABLE"): ChatStreamEvent {
  switch (code) {
    case "BAD_REQUEST":
      return {
        type: "error",
        code,
        message: "The message couldn't be read. Please try again.",
        retryable: false,
      };
    case "RATE_LIMITED":
      return {
        type: "error",
        code,
        message: "Lots of people are chatting right now. Please try again in a moment.",
        retryable: true,
      };
    case "AGENT_UNAVAILABLE":
      return {
        type: "error",
        code,
        message: "The assistant isn't available right now. Please try again.",
        retryable: true,
      };
  }
}

export interface MockApi {
  handlers: ReturnType<typeof http.post>[];
  /** Forget the conversations this mock has seen. */
  reset: () => void;
}

/**
 * Build the handlers. `getOptions` is read on every request, so changing options takes effect on
 * the next call without restarting the worker.
 */
export function createMockApi(getOptions: () => MockApiOptions): MockApi {
  /** Highest message sequence number used per conversation. */
  const lastSeq = new Map<string, number>();
  const reset = () => {
    lastSeq.clear();
    lastSeq.set(RESTORE_CONVERSATION_ID, SESSIONS.restore.messages.length);
  };
  reset();

  const session = http.post("/api/session", async () => {
    const options = getOptions();
    await sleep(options.latencyMs);
    switch (options.sessionFault) {
      case "network":
        return HttpResponse.error();
      case "unauthorized":
        return unauthorized();
      case "internal":
        return HttpResponse.json(
          {
            error: { code: "INTERNAL", message: "Something went wrong on our side. Please try again." },
          } satisfies ApiError,
          { status: 500 },
        );
      case "none":
        return HttpResponse.json(SessionResponse.parse(SESSIONS[options.session]));
    }
  });

  const chat = http.post("/api/chat", async ({ request }) => {
    const options = getOptions();
    if (options.chatFault === "network") {
      await sleep(options.latencyMs);
      return HttpResponse.error();
    }
    if (options.chatFault === "unauthorized") {
      await sleep(options.latencyMs);
      return unauthorized();
    }

    const parsed = ChatRequest.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      await sleep(options.latencyMs);
      return ndjson([errorEvent("BAD_REQUEST")], 400);
    }
    if (options.chatFault === "rate_limited" || options.chatFault === "unavailable") {
      await sleep(options.latencyMs);
      return options.chatFault === "rate_limited"
        ? ndjson([errorEvent("RATE_LIMITED")], 429)
        : ndjson([errorEvent("AGENT_UNAVAILABLE")], 503);
    }

    // The model's time to first token: no headers until the first event (ADR-007).
    await sleep(options.firstEventMs);

    const reply = REPLIES[options.chatReply];
    if (options.chatFault === "mid_stream") {
      const partial = reply.events.slice(0, Math.ceil(reply.events.length / 2));
      return ndjsonStream(
        [...partial, errorEvent("AGENT_UNAVAILABLE")],
        options.eventIntervalMs,
        request.signal,
      );
    }

    const conversationId = parsed.data.conversationId ?? crypto.randomUUID();
    const seq = (lastSeq.get(conversationId) ?? 0) + 2; // the patient's message, then this reply
    lastSeq.set(conversationId, seq);
    const done: ChatStreamEvent = {
      type: "done",
      conversationId,
      messageId: messageIdForSeq(seq),
      usage: SAMPLE_USAGE,
    };
    return ndjsonStream([...reply.events, done], options.eventIntervalMs, request.signal);
  });

  return { handlers: [session, chat], reset };
}
