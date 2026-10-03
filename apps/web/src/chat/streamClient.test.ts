import { type ChatStreamEvent, encodeStreamEvent, TOOL_STATUS_LABELS } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { ChatProtocolError, readChatStream } from "./streamClient";

const status: ChatStreamEvent = {
  type: "status",
  tool: "check_availability",
  label: TOOL_STATUS_LABELS.check_availability,
};
const delta = (text: string): ChatStreamEvent => ({ type: "text_delta", text });
const done: ChatStreamEvent = {
  type: "done",
  conversationId: "5a0c9e7b-3d2f-4b61-8e4a-7c1f0d9b2e63",
  messageId: "msg_000002",
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const error: ChatStreamEvent = {
  type: "error",
  code: "AGENT_UNAVAILABLE",
  message: "The assistant isn't available right now. Please try again.",
  retryable: true,
};

const bytes = (text: string) => new TextEncoder().encode(text);

/** A body that delivers exactly these chunks, then ends. */
function bodyOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? bytes(chunk) : chunk);
      controller.close();
    },
  });
}

async function read(chunks: (string | Uint8Array)[]) {
  const seen: ChatStreamEvent[] = [];
  const events = await readChatStream(bodyOf(chunks), (event) => seen.push(event));
  return { seen, events };
}

describe("readChatStream", () => {
  it("reads NDJSON events in order, one per line", async () => {
    const all = [status, delta("Hello "), delta("there."), done];
    const { seen, events } = await read([all.map(encodeStreamEvent).join("")]);
    expect(seen).toEqual(all);
    expect(events).toEqual(all);
  });

  it("joins a line split across chunks, including a multi-byte character split mid-way", async () => {
    const line = encodeStreamEvent(delta("Café ☕ at 9:00"));
    const encoded = bytes(line + encodeStreamEvent(done));
    // Cut inside the 3-byte "☕" (after its first byte) and inside the JSON.
    const cut = bytes(line.slice(0, line.indexOf("☕"))).length + 1;
    const { seen } = await read([encoded.slice(0, 5), encoded.slice(5, cut), encoded.slice(cut)]);
    expect(seen).toEqual([delta("Café ☕ at 9:00"), done]);
  });

  it("hands each event over as soon as its line is complete, before the stream ends", async () => {
    let push!: (text: string) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(bytes(text));
        close = () => controller.close();
      },
    });
    const seen: ChatStreamEvent[] = [];
    let firstSeen!: () => void;
    const first = new Promise<void>((resolve) => (firstSeen = resolve));
    const reading = readChatStream(body, (event) => {
      seen.push(event);
      firstSeen();
    });

    push(encodeStreamEvent(delta("Hi")));
    await first;
    expect(seen).toEqual([delta("Hi")]);

    push(encodeStreamEvent(done));
    close();
    await expect(reading).resolves.toEqual([delta("Hi"), done]);
  });

  it("reads a last line that has no trailing newline, and skips blank lines", async () => {
    const { seen } = await read([`\n${encodeStreamEvent(delta("Hi"))}\n\n${JSON.stringify(done)}`]);
    expect(seen).toEqual([delta("Hi"), done]);
  });

  it("reads the buffered fallback: one JSON array, after a blank chunk and split across chunks", async () => {
    const all = [status, delta("Hello"), done];
    const json = JSON.stringify(all);
    const { seen, events } = await read([" \n", json.slice(0, 7), json.slice(7)]);
    expect(seen).toEqual(all);
    expect(events).toEqual(all);
  });

  it("delivers an error event as the last event", async () => {
    const { seen } = await read([encodeStreamEvent(delta("Partial")) + encodeStreamEvent(error)]);
    expect(seen).toEqual([delta("Partial"), error]);
  });

  it.each([
    ["NDJSON", () => [encodeStreamEvent(status) + encodeStreamEvent(delta("Hi"))]],
    ["a buffered array", () => [JSON.stringify([status, delta("Hi")])]],
    ["an empty body", () => []],
  ])("rejects %s that ends without done or error", async (_, chunks) => {
    await expect(read(chunks())).rejects.toBeInstanceOf(ChatProtocolError);
  });

  it("rejects an event after the terminal one", async () => {
    await expect(read([encodeStreamEvent(done) + encodeStreamEvent(delta("more"))])).rejects.toThrow(
      ChatProtocolError,
    );
  });

  it.each([
    ["malformed JSON", "{not json\n"],
    ["an unknown event type", `${JSON.stringify({ type: "thinking", text: "hm" })}\n`],
    ["a malformed buffered array", "[{"],
  ])("rejects %s with a ChatProtocolError", async (_, text) => {
    await expect(read([text + encodeStreamEvent(done)])).rejects.toBeInstanceOf(ChatProtocolError);
  });

  it("hands over the events before a bad line, then rejects", async () => {
    const seen: ChatStreamEvent[] = [];
    await expect(
      readChatStream(bodyOf([`${encodeStreamEvent(delta("Hi"))}oops\n`]), (e) => seen.push(e)),
    ).rejects.toBeInstanceOf(ChatProtocolError);
    expect(seen).toEqual([delta("Hi")]);
  });
});
