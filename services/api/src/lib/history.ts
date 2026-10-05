/**
 * Stored conversation messages ↔ the agent loop's history (append-only, CLAUDE.md rule 4).
 *
 * Stored `content` is the loop's provider-neutral content blocks, verbatim (reasoning blocks and their
 * signatures included), so the mapping is a field projection both ways. Nothing is ever edited.
 */
import { FALLBACK_MESSAGES, type LlmMessage } from "@sched/agent";
import type { ConversationId, ConversationMessage, TurnId } from "@sched/contracts";

export function toLlmHistory(messages: readonly ConversationMessage[]): LlmMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** True when the last stored message is the patient's (or tool results) with no assistant reply after it. */
export function needsClosingReply(messages: readonly { role: string }[]): boolean {
  return messages.at(-1)?.role === "user";
}

/** A message to store. The patient's message carries the `clientMessageId` it was sent with (#104). */
export type OutgoingMessage = LlmMessage & { clientMessageId?: string };

/** Numbers messages for storage from `firstSeq`, all in one turn at one time. */
export function toStoredMessages(
  messages: readonly OutgoingMessage[],
  at: { conversationId: ConversationId; turnId: TurnId; firstSeq: number; createdAt: string },
): ConversationMessage[] {
  return messages.map((m, i) => ({
    conversationId: at.conversationId,
    seq: at.firstSeq + i,
    role: m.role,
    content: m.content,
    turnId: at.turnId,
    createdAt: at.createdAt,
    ...(m.clientMessageId === undefined ? {} : { clientMessageId: m.clientMessageId }),
  }));
}

/** The text of a stored message's text blocks, joined (a patient message has exactly one). */
export function textOf(message: ConversationMessage): string {
  return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

/**
 * The index of the last patient message: a user message with text. A user message of tool results
 * only is part of the agent's turn, not something the patient sent. -1 when there is none.
 */
export function lastPatientMessageIndex(messages: readonly ConversationMessage[]): number {
  return messages.findLastIndex((m) => m.role === "user" && m.content.some((b) => b.type === "text"));
}

/**
 * Closes a turn that ended without an assistant reply. Converse requires user and assistant messages to
 * alternate, so without it the next turn's request would be invalid. Stored as an ordinary assistant
 * message (`FALLBACK_MESSAGES.interrupted`), so a restored session and the next model call both see
 * that the reply didn't happen.
 *
 * When it is stored (#104, ADR-007 amendment):
 * - a turn that fails after a tool ran is closed at once, and a Retry of it replays this reply;
 * - a turn that fails before any tool ran is NOT closed: it ends at the patient's message, so a Retry
 *   with the same `clientMessageId` runs the agent again on it. A different, new message closes it
 *   first, in the same append.
 */
export const closingReply = (): LlmMessage => ({
  role: "assistant",
  content: [{ type: "text", text: FALLBACK_MESSAGES.interrupted }],
});
