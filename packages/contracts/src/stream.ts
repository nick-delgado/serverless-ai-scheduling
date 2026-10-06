/**
 * Chat stream events (ADR-007). `POST /api/chat` streams newline-delimited JSON, one event per line,
 * and always ends with `done` or `error`. The buffered fallback returns the same events as one JSON array.
 */
import { z } from "zod";

import { ConversationId, MessageId } from "./ids";
import { TokenUsage } from "./primitives";
import { ToolName } from "./tools";

export const ChatStatusEvent = z.strictObject({
  type: z.literal("status"),
  tool: ToolName,
  label: z.string().min(1).max(120),
});

export const ChatTextDeltaEvent = z.strictObject({
  type: z.literal("text_delta"),
  text: z.string().min(1),
});

/**
 * Discard streamed text that won't be kept (contracts v1.1, ADR-007). The loop sends it when it throws
 * away a response whose text already streamed (a refusal, a `max_tokens` cut-off, malformed output) and
 * retries. The client truncates the in-progress assistant bubble to its first `keepChars` characters
 * (JavaScript string length, i.e. UTF-16 code units, counted over every `text_delta` of this turn),
 * drops anything still queued in its typewriter buffer beyond that, and keeps rendering the deltas that
 * follow. Applying every reset in order yields exactly the text the turn stored.
 */
export const ChatTextResetEvent = z.strictObject({
  type: z.literal("text_reset"),
  keepChars: z.int().nonnegative(),
});

/**
 * Names the new conversation a turn opened (contracts v1.2, #160). Sent once, as the first event, as
 * soon as the patient's message is stored and before the agent runs, on a turn that starts a
 * conversation (no `conversationId` in the request, or one that read as empty). The client remembers
 * it as it does `done.conversationId`, so a Retry after the stream is cut continues the conversation
 * instead of storing the message again in a new one (FR-015). Not terminal. A turn that continues a
 * stored conversation doesn't send it.
 */
export const ChatConversationEvent = z.strictObject({
  type: z.literal("conversation"),
  conversationId: ConversationId,
});

export const ChatDoneEvent = z.strictObject({
  type: z.literal("done"),
  conversationId: ConversationId,
  messageId: MessageId,
  usage: TokenUsage,
});

export const ChatErrorCode = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "AGENT_UNAVAILABLE",
  "INTERNAL",
]);
export type ChatErrorCode = z.infer<typeof ChatErrorCode>;

export const ChatErrorEvent = z.strictObject({
  type: z.literal("error"),
  code: ChatErrorCode,
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  /**
   * The conversation this turn belongs to, whenever it exists in storage when the error is sent (the
   * patient's message was stored, or the request continued a stored conversation), so a Retry after a
   * failed first turn continues it (FR-014, FR-015, #104). Omitted otherwise.
   */
  conversationId: ConversationId.optional(),
});

export const ChatStreamEvent = z.discriminatedUnion("type", [
  ChatStatusEvent,
  ChatTextDeltaEvent,
  ChatTextResetEvent,
  ChatConversationEvent,
  ChatDoneEvent,
  ChatErrorEvent,
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>;

/** Buffered fallback body: the whole turn's events as one array, ending with `done` or `error`. */
export const ChatStreamEventList = z
  .array(ChatStreamEvent)
  .min(1)
  .refine((events) => isTerminalEvent(events[events.length - 1]), {
    message: "The last event must be done or error",
  });

/** Default status-chip labels (FR-012). Handlers may substitute a more specific label. */
export const TOOL_STATUS_LABELS: Record<ToolName, string> = {
  find_providers: "Looking up providers…",
  check_availability: "Checking availability…",
  get_my_appointments: "Looking up your appointments…",
  get_patient_profile: "Checking your details…",
  book_appointment: "Booking your appointment…",
  reschedule_appointment: "Rescheduling your appointment…",
  escalate_to_human: "Contacting the front desk…",
};

/**
 * The assistant text a client shows after these events: `text_delta`s appended in order, each
 * `text_reset` truncating to its `keepChars`. The reference implementation of the client rule above.
 */
export function visibleText(events: readonly ChatStreamEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "text_reset") text = text.slice(0, event.keepChars);
  }
  return text;
}

export function isTerminalEvent(event: ChatStreamEvent | undefined): boolean {
  return event?.type === "done" || event?.type === "error";
}

/** Validate and serialize one event as an NDJSON line. Throws if the event breaks the contract. */
export function encodeStreamEvent(event: ChatStreamEvent): string {
  return `${JSON.stringify(ChatStreamEvent.parse(event))}\n`;
}

/** Parse one NDJSON line. Throws on malformed JSON or a contract violation. */
export function parseStreamEventLine(line: string): ChatStreamEvent {
  return ChatStreamEvent.parse(JSON.parse(line));
}

/** Parse a complete response body in either form: NDJSON (streaming) or a JSON array (buffered fallback). */
export function parseChatResponseBody(body: string): ChatStreamEvent[] {
  const trimmed = body.trim();
  if (trimmed.startsWith("[")) return ChatStreamEventList.parse(JSON.parse(trimmed));
  return trimmed
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseStreamEventLine);
}
