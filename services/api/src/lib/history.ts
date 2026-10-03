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

/** Numbers messages for storage from `firstSeq`, all in one turn at one time. */
export function toStoredMessages(
  messages: readonly LlmMessage[],
  at: { conversationId: ConversationId; turnId: TurnId; firstSeq: number; createdAt: string },
): ConversationMessage[] {
  return messages.map((m, i) => ({
    conversationId: at.conversationId,
    seq: at.firstSeq + i,
    role: m.role,
    content: m.content,
    turnId: at.turnId,
    createdAt: at.createdAt,
  }));
}

/**
 * Closes a turn that ended without an assistant reply (a model error, a timeout, a crash after the
 * patient's message was stored). Converse requires user and assistant messages to alternate, so without
 * it the next turn's request would be invalid. Stored as an ordinary assistant message
 * (`FALLBACK_MESSAGES.interrupted`), so a restored session and the next model call both see that the
 * reply didn't happen.
 */
export const closingReply = (): LlmMessage => ({
  role: "assistant",
  content: [{ type: "text", text: FALLBACK_MESSAGES.interrupted }],
});
