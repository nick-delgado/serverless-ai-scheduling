/**
 * MSW handlers that stand in for the API (S5-01, #24), so UI work never waits on it. Bodies and
 * events are validated against @sched/contracts on the way out, so the mock can't drift from the
 * real shapes without a test failing.
 *
 * - `POST /api/session`: a `SessionResponse`.
 * - `POST /api/chat`: `ChatStreamEvent`s as NDJSON, ending in `done` or `error` (ADR-007). A turn
 *   that starts a conversation (no `conversationId`, or one this mock hasn't seen, which the real API
 *   reads as empty) opens with a `conversation` event once the message is "stored", as the chat
 *   handler does (#160), and its agent failures then answer 200 with an `error` event.
 */
import {
  type ApiError,
  ChatRequest,
  type ChatStreamEvent,
  DAILY_CAP_MESSAGE,
  encodeStreamEvent,
  messageIdForSeq,
  SessionResponse,
} from "@sched/contracts";
import { http, HttpResponse } from "msw";

import { cognitoHandlers } from "./cognito";
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
 * A 200 NDJSON stream: the first event right away (the caller has already waited, so headers and
 * first event arrive together), then one event per `intervalMs`, except that the second waits
 * `afterFirstMs` when given (the model's time to first token after a `conversation` event). Stops
 * early if the client aborts. Exported for its tests.
 */
export function ndjsonStream(
  events: readonly ChatStreamEvent[],
  intervalMs: number,
  signal: AbortSignal,
  afterFirstMs: number = intervalMs,
): Response {
  const encoder = new TextEncoder();
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next > 0) await sleep(next === 1 ? afterFirstMs : intervalMs);
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

/** The chat handler's error answers, by kind: each `ChatErrorCode` the mock uses, plus the daily cap. */
function errorEvent(
  kind: "BAD_REQUEST" | "RATE_LIMITED" | "DAILY_CAP" | "AGENT_UNAVAILABLE",
): Extract<ChatStreamEvent, { type: "error" }> {
  switch (kind) {
    case "BAD_REQUEST":
      return {
        type: "error",
        code: kind,
        message: "The message couldn't be read. Please try again.",
        retryable: false,
      };
    case "RATE_LIMITED":
      return {
        type: "error",
        code: kind,
        message: "Lots of people are chatting right now. Please try again in a moment.",
        retryable: true,
      };
    case "DAILY_CAP":
      // The chat handler's daily-cap answer (services/api/src/lib/errors.ts): a RATE_LIMITED that
      // isn't retryable, with the front desk's number and hours (FR-017).
      return {
        type: "error",
        code: "RATE_LIMITED",
        message: DAILY_CAP_MESSAGE,
        retryable: false,
      };
    case "AGENT_UNAVAILABLE":
      return {
        type: "error",
        code: kind,
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
    if (options.chatFault === "daily_cap") {
      // Refused before the message is stored: no conversation to name.
      await sleep(options.latencyMs);
      return ndjson([errorEvent("DAILY_CAP")], 429);
    }

    // The patient's message is stored. A conversation this mock hasn't seen reads as empty, so the
    // turn starts a new one, named in a first `conversation` event before the model runs (#160).
    const requested = parsed.data.conversationId;
    const opens = requested === undefined || !lastSeq.has(requested);
    const conversationId = opens ? crypto.randomUUID() : requested;
    const patientSeq = (lastSeq.get(conversationId) ?? 0) + 1;
    lastSeq.set(conversationId, patientSeq);

    // An agent failure names the stored conversation, as the chat handler's does (#104).
    const failure = (kind: "RATE_LIMITED" | "AGENT_UNAVAILABLE") => ({ ...errorEvent(kind), conversationId });
    const agentFault =
      options.chatFault === "rate_limited"
        ? { event: failure("RATE_LIMITED"), status: 429 }
        : options.chatFault === "unavailable"
          ? { event: failure("AGENT_UNAVAILABLE"), status: 503 }
          : undefined;
    const reply = REPLIES[options.chatReply];
    let events: ChatStreamEvent[];
    if (agentFault) {
      if (!opens) {
        // A continued conversation keeps the status: nothing was written before the model failed.
        await sleep(options.latencyMs);
        return ndjson([agentFault.event], agentFault.status);
      }
      events = [agentFault.event];
    } else if (options.chatFault === "mid_stream") {
      const partial = reply.events.slice(0, Math.ceil(reply.events.length / 2));
      events = [...partial, failure("AGENT_UNAVAILABLE")];
    } else {
      const seq = patientSeq + 1; // this reply
      lastSeq.set(conversationId, seq);
      events = [
        ...reply.events,
        { type: "done", conversationId, messageId: messageIdForSeq(seq), usage: SAMPLE_USAGE },
      ];
    }

    if (opens) {
      // The `conversation` event goes out once the message is stored, then the model's time to first token.
      await sleep(options.latencyMs);
      return ndjsonStream(
        [{ type: "conversation", conversationId }, ...events],
        options.eventIntervalMs,
        request.signal,
        options.firstEventMs,
      );
    }
    // The model's time to first token: no headers until the first event (ADR-007).
    await sleep(options.firstEventMs);
    return ndjsonStream(events, options.eventIntervalMs, request.signal);
  });

  return { handlers: [session, chat, ...cognitoHandlers], reset };
}
