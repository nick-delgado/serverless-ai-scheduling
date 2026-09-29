/**
 * Walking-skeleton chat turn (M1-05, #7): validate a `POST /api/chat` body, stream one model reply
 * as NDJSON `text_delta` events, and always finish with `done` or `error` (ADR-007).
 *
 * TEMPORARY. There is no agent loop, no tools, and no history here: the model is called directly,
 * with a demo system prompt. S3-03 (#17) replaces this with `runAgentTurn` + `LlmClient` from
 * `packages/agent`. The streaming shell (`EventSink`, status handling, always-terminate) is the part
 * worth keeping.
 */
import { randomUUID } from "node:crypto";

import { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import {
  ChatRequest,
  encodeStreamEvent,
  messageIdForSeq,
  type ChatErrorCode,
  type ChatStreamEvent,
  type TokenUsage,
} from "@sched/contracts";

/** Token counts as the SDK reports them (message_start has the initial values, message_delta the cumulative ones). */
interface SdkUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * The slice of the Anthropic SDK's raw stream events that the skeleton reads. The SDK's
 * `RawMessageStreamEvent` is assignable to it, and tests can build fakes without a full `Message`.
 */
export type ModelStreamEvent =
  | { type: "message_start"; message: { usage: SdkUsage } }
  | { type: "message_delta"; usage: SdkUsage; delta: { stop_reason: string | null } }
  | { type: "content_block_delta"; delta: { type: string; text?: string } }
  | { type: "content_block_start" | "content_block_stop" | "message_stop" };

export interface ModelRequest {
  system: string;
  userText: string;
}

/** Opens a streaming model call. Resolves once the model has accepted the request (HTTP headers received). */
export type OpenModelStream = (request: ModelRequest) => Promise<AsyncIterable<ModelStreamEvent>>;

/** Where events go. The Lambda wraps `awslambda.HttpResponseStream`; tests use an in-memory sink. */
export interface EventSink {
  /** Sets the HTTP status and headers. Called exactly once, before the first write. */
  open(statusCode: number): void;
  write(chunk: string): void;
  /** Ends the response. Always called, whatever happened before. */
  end(): Promise<void>;
}

export interface ChatTurnInput {
  body: string | null;
  isBase64Encoded?: boolean;
  /** Cognito `sub` from the authorizer's verified claims. Never read from the body (CLAUDE.md rule 1). */
  patientId: string | undefined;
  requestId: string;
}

export interface ChatTurnDeps {
  openModelStream: OpenModelStream;
  newConversationId?: () => string;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export const SKELETON_SYSTEM_PROMPT = [
  "You are the scheduling assistant for Cedar Ridge Health, a fictional clinic.",
  "This is a walking-skeleton demo: you cannot look up, book, or change appointments yet.",
  "Answer briefly and warmly in plain text (no markdown). If asked to schedule, say that",
  "booking is coming soon and suggest calling the front desk.",
].join(" ");

interface Failure {
  httpStatus: number;
  event: Extract<ChatStreamEvent, { type: "error" }>;
}

function failure(httpStatus: number, code: ChatErrorCode, message: string, retryable: boolean): Failure {
  return { httpStatus, event: { type: "error", code, message, retryable } };
}

/** Maps a model/SDK error to a patient-safe error event. Details go to the log, not the client. */
export function classifyModelError(err: unknown): Failure {
  if (err instanceof APIError && (err.status === 429 || err.type === "rate_limit_error")) {
    return failure(
      429,
      "RATE_LIMITED",
      "The assistant is busy right now. Please try again in a moment.",
      true,
    );
  }
  if (
    err instanceof APIConnectionError ||
    (err instanceof APIError && (err.type === "overloaded_error" || (err.status ?? 0) >= 500))
  ) {
    return failure(
      503,
      "AGENT_UNAVAILABLE",
      "The assistant is temporarily unavailable. Please try again.",
      true,
    );
  }
  return failure(500, "INTERNAL", "Something went wrong on our side.", false);
}

function parseBody(input: ChatTurnInput): ReturnType<typeof ChatRequest.safeParse> | { success: false } {
  if (input.body === null) return { success: false };
  const raw = input.isBase64Encoded ? Buffer.from(input.body, "base64").toString("utf8") : input.body;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { success: false };
  }
  return ChatRequest.safeParse(json);
}

function mergeUsage(total: TokenUsage, u: SdkUsage): void {
  // message_delta counts are cumulative, so the latest non-null value wins.
  total.inputTokens = u.input_tokens ?? total.inputTokens;
  total.outputTokens = u.output_tokens ?? total.outputTokens;
  total.cacheReadTokens = u.cache_read_input_tokens ?? total.cacheReadTokens;
  total.cacheWriteTokens = u.cache_creation_input_tokens ?? total.cacheWriteTokens;
}

/**
 * Runs one skeleton turn and writes NDJSON to `sink`.
 *
 * - Bad input → HTTP 400 with a single `error` event. The model is never called.
 * - The model refuses the request up front (throttled, unavailable) → 429/503/500 with one `error` event.
 * - Otherwise HTTP 200: `text_delta`… then `done`, or `error` if the stream breaks midway.
 *
 * The status is chosen lazily, because the runtime writes the status/headers prelude on the first write.
 */
export async function runChatTurn(input: ChatTurnInput, deps: ChatTurnDeps, sink: EventSink): Promise<void> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const startedAt = now();
  let opened = false;
  let deltas = 0;
  let firstDeltaMs: number | null = null;
  let outcome = "unknown";

  const send = (httpStatus: number, event: ChatStreamEvent): void => {
    const line = encodeStreamEvent(event); // validates against the contract before anything is written
    if (!opened) {
      sink.open(httpStatus);
      opened = true;
    }
    sink.write(line);
  };
  const fail = (f: Failure, err?: unknown): void => {
    outcome = f.event.code;
    if (err !== undefined)
      log({ msg: "chat turn failed", requestId: input.requestId, code: f.event.code, err: String(err) });
    send(f.httpStatus, f.event);
  };

  try {
    // The authorizer rejects unauthenticated calls before we run; this is defense in depth.
    if (!input.patientId) {
      fail(failure(401, "UNAUTHORIZED", "Please sign in again.", false));
      return;
    }
    const parsed = parseBody(input);
    if (!parsed.success) {
      fail(failure(400, "BAD_REQUEST", "The message couldn't be read. Please try again.", false));
      return;
    }
    const request = parsed.data;

    let stream: AsyncIterable<ModelStreamEvent>;
    try {
      stream = await deps.openModelStream({ system: SKELETON_SYSTEM_PROMPT, userText: request.text });
    } catch (err) {
      fail(classifyModelError(err), err);
      return;
    }

    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta" && event.delta.text) {
            firstDeltaMs ??= now() - startedAt;
            deltas += 1;
            send(200, { type: "text_delta", text: event.delta.text });
          }
        } else if (event.type === "message_start") {
          mergeUsage(usage, event.message.usage);
        } else if (event.type === "message_delta") {
          mergeUsage(usage, event.usage);
        }
      }
    } catch (err) {
      fail(classifyModelError(err), err);
      return;
    }

    outcome = "done";
    send(200, {
      type: "done",
      conversationId: request.conversationId ?? (deps.newConversationId ?? randomUUID)(),
      // Placeholder: the skeleton stores nothing. S3-03 (#17) assigns real sequence numbers.
      messageId: messageIdForSeq(1),
      usage,
    });
  } catch (err) {
    // Unexpected (e.g. an event that broke the contract). Try once to tell the client, then give up.
    try {
      fail(failure(500, "INTERNAL", "Something went wrong on our side.", false), err);
    } catch {
      // Nothing more we can send; the stream still ends below.
    }
  } finally {
    if (!opened) {
      sink.open(500);
      opened = true;
    }
    await sink.end();
    log({
      msg: "chat turn",
      requestId: input.requestId,
      outcome,
      deltas,
      firstDeltaMs,
      totalMs: now() - startedAt,
    });
  }
}
