/**
 * Synthetic data for the mock API: fictional Cedar Ridge Health patients and providers only. The
 * session builds on the contracts' own example, so the mock and the contract tests agree on shapes.
 */
import { type ChatStreamEvent, type SessionResponse, TOOL_STATUS_LABELS } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";

import type { MockApiOptions } from "./options";

/** The conversation the `restore` session variant returns. */
export const RESTORE_CONVERSATION_ID = "5a0c9e7b-3d2f-4b61-8e4a-7c1f0d9b2e63";

const UPCOMING: SessionResponse = EXAMPLES.SessionResponse;

export const SESSIONS: Record<MockApiOptions["session"], SessionResponse> = {
  upcoming: UPCOMING,
  no_upcoming: {
    ...UPCOMING,
    greeting: "Hi Maria! How can I help today?",
    upcomingAppointment: null,
  },
  restore: {
    ...UPCOMING,
    conversationId: RESTORE_CONVERSATION_ID,
    messages: [
      {
        id: "msg_000001",
        role: "patient",
        text: "Does Dr. Lee have anything earlier next week?",
        createdAt: "2026-10-05T13:00:00Z",
      },
      {
        id: "msg_000002",
        role: "assistant",
        text: "Dr. Priya Lee has an opening on Monday, October 12 at 10:00 AM ET. Would you like to move your appointment there?",
        createdAt: "2026-10-05T13:00:06Z",
      },
    ],
  },
};

const PLAIN_TEXT =
  "I can check availability, book or reschedule an appointment, or connect you with the front desk. " +
  "What would you like to do?";

const AVAILABILITY_TEXT =
  "Dr. Priya Lee has three openings next week: Wednesday, October 14 at 9:00 AM, " +
  "Thursday, October 15 at 11:30 AM, and Friday, October 16 at 3:00 PM ET. Would you like me to book one?";

/** Split text the way a model streams it: a word or two per delta. */
export function textDeltas(text: string): ChatStreamEvent[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const deltas: ChatStreamEvent[] = [];
  for (let i = 0; i < words.length; i += 2) {
    deltas.push({ type: "text_delta", text: words.slice(i, i + 2).join("") });
  }
  return deltas;
}

const availabilityStatus: ChatStreamEvent = {
  type: "status",
  tool: "check_availability",
  label: TOOL_STATUS_LABELS.check_availability,
};

const RESET_KEPT = "Let me look into that. ";

/** The events of a successful turn, before its `done`, and the text the client should end up showing. */
export const REPLIES: Record<MockApiOptions["chatReply"], { events: ChatStreamEvent[]; text: string }> = {
  plain: { events: textDeltas(PLAIN_TEXT), text: PLAIN_TEXT },
  tools: { events: [availabilityStatus, ...textDeltas(AVAILABILITY_TEXT)], text: AVAILABILITY_TEXT },
  reset: {
    // The loop discards a response after part of it streamed, keeps the opening, and retries (ADR-007).
    events: [
      ...textDeltas(`${RESET_KEPT}I'm not able to`),
      { type: "text_reset", keepChars: RESET_KEPT.length },
      availabilityStatus,
      ...textDeltas(AVAILABILITY_TEXT),
    ],
    text: `${RESET_KEPT}${AVAILABILITY_TEXT}`,
  },
};

export const SAMPLE_USAGE = {
  inputTokens: 1840,
  outputTokens: 96,
  cacheReadTokens: 4070,
  cacheWriteTokens: 0,
};
