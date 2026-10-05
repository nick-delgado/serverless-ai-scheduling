/**
 * Reads a `POST /api/chat` response body into `ChatStreamEvent`s (ADR-007), in either shape:
 * - NDJSON, streamed: each event is handed to `onEvent` as soon as its line is complete;
 * - the buffered fallback, one JSON array: handed over event by event once the body has ended.
 *
 * Parsing goes through `parseStreamEventLine` / `parseChatResponseBody` from @sched/contracts, so the
 * client accepts exactly what the contract allows. Anything else is a `ChatProtocolError`, as is a
 * body that ends without `done` or `error`: a cut stream must never look like a finished reply.
 */
import {
  type ChatStreamEvent,
  isTerminalEvent,
  parseChatResponseBody,
  parseStreamEventLine,
} from "@sched/contracts";

/**
 * A response body broke the API contract: a session body that isn't a `SessionResponse`, or a chat
 * stream with a malformed line, an unknown event, or no `done`/`error` at the end.
 */
export class ChatProtocolError extends Error {
  override readonly name: string = "ChatProtocolError";
}

/**
 * The stream ended cleanly without its `done` or `error` event, including an empty body: the turn was
 * cut short, not malformed, so the chat page offers Retry for it (#138). A final line cut mid-way is
 * still an unreadable event, a plain `ChatProtocolError`.
 */
export class ChatStreamEndedError extends ChatProtocolError {
  override readonly name = "ChatStreamEndedError";
}

function parseLine(line: string): ChatStreamEvent {
  try {
    return parseStreamEventLine(line);
  } catch (cause) {
    throw new ChatProtocolError("The chat stream contained an unreadable event.", { cause });
  }
}

function parseBuffered(body: string): ChatStreamEvent[] {
  try {
    return parseChatResponseBody(body);
  } catch (cause) {
    throw new ChatProtocolError("The chat response couldn't be read.", { cause });
  }
}

/**
 * Read `body` to its end, calling `onEvent` once per event, in order. Resolves with every event
 * (the last one is `done` or `error`); rejects with `ChatProtocolError` on a contract violation (its
 * subclass `ChatStreamEndedError` when the body ends without `done` or `error`), or
 * with the reader's own error if the connection fails or the request is aborted. A contract violation
 * found while the body is still open cancels it.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<ChatStreamEvent[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: ChatStreamEvent[] = [];
  const emit = (event: ChatStreamEvent) => {
    if (isTerminalEvent(events[events.length - 1])) {
      throw new ChatProtocolError("The chat stream continued after its last event.");
    }
    events.push(event);
    onEvent(event);
  };

  /** Undecided until the first non-blank character: `[` means the buffered array. */
  let mode: "unknown" | "ndjson" | "array" = "unknown";
  let pending = "";

  const drainLines = () => {
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim().length > 0) emit(parseLine(line));
      newline = pending.indexOf("\n");
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (mode === "unknown") {
        const start = pending.trimStart();
        if (start.length > 0) mode = start.startsWith("[") ? "array" : "ndjson";
      }
      if (mode === "ndjson") drainLines();
      if (done) break;
    }
  } catch (error) {
    // A bad line on an open stream: close the response rather than leave it running. The caller
    // gets the error that stopped the read, even if cancelling fails too.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (mode === "array") {
    for (const event of parseBuffered(pending)) emit(event);
  } else if (pending.trim().length > 0) {
    // The last line may come without its newline.
    emit(parseLine(pending));
  }

  if (!isTerminalEvent(events[events.length - 1])) {
    throw new ChatStreamEndedError("The chat stream ended before the reply was complete.");
  }
  return events;
}
