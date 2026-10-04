/**
 * Stored conversation messages → the chat bubbles a restored session shows (FR-014, `DisplayMessage`).
 *
 * Restore must show what the patient saw live, and nothing the model kept to itself:
 * - Text only. `tool_use`, `tool_result` and `reasoning` blocks never leave the server.
 * - A user message with text is one patient bubble. A user message without text (tool results only) is
 *   part of the agent's turn and isn't shown.
 * - Everything the assistant said between two patient messages is ONE bubble, its non-empty text blocks
 *   joined by a blank line, in order. That is exactly what the live stream built: the loop streams one
 *   bubble per turn and separates text blocks with `TEXT_BLOCK_SEPARATOR` (`packages/agent/src/loop.ts`).
 *   A closing reply stored for an interrupted turn (`history.ts`) joins the bubble it closes.
 * - The assistant bubble's `id` and `createdAt` are those of its last assistant message with text: for a
 *   completed turn that's the stored reply, the same `messageId` the live `done` event carried.
 *
 * Kept free of `@sched/agent` so the session Lambda doesn't bundle the agent loop; a test pins
 * `DISPLAY_TEXT_SEPARATOR` to the loop's `TEXT_BLOCK_SEPARATOR`.
 */
import { messageIdForSeq, type ConversationMessage, type DisplayMessage } from "@sched/contracts";

/** Must equal `TEXT_BLOCK_SEPARATOR` in `@sched/agent` (pinned by `test/display.test.ts`). */
export const DISPLAY_TEXT_SEPARATOR = "\n\n";

function textOf(message: ConversationMessage): string[] {
  return message.content.flatMap((b) => (b.type === "text" && b.text.length > 0 ? [b.text] : []));
}

export function toDisplayMessages(messages: readonly ConversationMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let reply: { texts: string[]; last: ConversationMessage } | undefined;
  const flush = (): void => {
    if (reply) {
      out.push({
        id: messageIdForSeq(reply.last.seq),
        role: "assistant",
        text: reply.texts.join(DISPLAY_TEXT_SEPARATOR),
        createdAt: reply.last.createdAt,
      });
    }
    reply = undefined;
  };

  for (const message of messages) {
    const texts = textOf(message);
    if (texts.length === 0) continue;
    if (message.role === "user") {
      flush();
      out.push({
        id: messageIdForSeq(message.seq),
        role: "patient",
        text: texts.join(DISPLAY_TEXT_SEPARATOR),
        createdAt: message.createdAt,
      });
    } else if (reply) {
      reply.texts.push(...texts);
      reply.last = message;
    } else {
      reply = { texts, last: message };
    }
  }
  flush();
  return out;
}
