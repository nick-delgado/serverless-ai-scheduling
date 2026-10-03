/**
 * The stream helpers on their own: `EventWriter` validates every event against the contract before it
 * touches the sink, and `memorySink` parses what it captures against the same contract.
 */
import type { ChatStreamEvent } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { EventWriter, memorySink } from "../src";

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("EventWriter", () => {
  it("throws on an event that breaks the contract, before opening or writing the sink", () => {
    const { sink, response } = memorySink();
    const writer = new EventWriter(sink);
    // A `done` whose conversationId isn't a UUID: valid TypeScript after the cast, invalid on the wire.
    const invalid = {
      type: "done",
      conversationId: "not-a-uuid",
      messageId: "msg_000001",
      usage: USAGE,
    } as unknown as ChatStreamEvent;

    expect(() => writer.send(200, invalid)).toThrow();
    expect(response.opens).toBe(0);
    expect(response.body).toBe("");
    expect(writer.opened).toBe(false);
    expect(writer.count).toBe(0);
  });
});

describe("memorySink", () => {
  it("rejects a written line that breaks the contract, and keeps nothing of it", () => {
    const { sink, response } = memorySink();
    sink.open(200);
    expect(() => sink.write(`${JSON.stringify({ type: "text_delta" })}\n`)).toThrow();
    expect(response.events).toEqual([]);
    expect(response.body).toBe("");
  });

  it("captures a valid line as a parsed event", () => {
    const { sink, response } = memorySink();
    sink.open(200);
    sink.write(`${JSON.stringify({ type: "text_delta", text: "Hi" })}\n`);
    expect(response.events).toEqual([{ type: "text_delta", text: "Hi" }]);
  });
});
