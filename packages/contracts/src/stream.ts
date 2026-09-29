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
});

export const ChatStreamEvent = z.discriminatedUnion("type", [
  ChatStatusEvent,
  ChatTextDeltaEvent,
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
