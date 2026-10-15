// @vitest-environment node
import type { TurnTrace } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { describe, expect, it, vi } from "vitest";

import { tracesOf } from "./table";

const A = "0f8d2c3a-5b6e-4f7a-8c9d-1e2f3a4b5c6d";
const B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const trace = (conversationId: string, turnId: string): TurnTrace => ({
  ...EXAMPLES.TurnTrace,
  conversationId,
  turnId,
});
const item = (t: TurnTrace) => ({
  SK: `TRACE#${t.turnId}`,
  startedAt: t.startedAt,
  trace: JSON.stringify(t),
});
const TA = trace(A, "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f");
const TB = trace(B, "8d2f3e4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a");

/** A document client whose query for `CONV#<id>` returns `items[id]`. */
function client(items: Record<string, unknown[]>) {
  const send = vi.fn((command: { input: { ExpressionAttributeValues: Record<string, string> } }) => {
    const pk = command.input.ExpressionAttributeValues[":pk"] ?? "";
    return Promise.resolve({ Items: items[pk.replace(/^CONV#/, "")] ?? [] });
  });
  return { send } as never;
}

describe("tracesOf", () => {
  it("returns every conversation's traces, conversation by conversation", async () => {
    const traces = await tracesOf(client({ [A]: [item(TA)], [B]: [item(TB)] }), "t1", [A, B]);
    expect(traces).toEqual([TA, TB]);
  });

  it("throws on an unreadable trace rather than leave its cost out", async () => {
    const bad = { SK: "TRACE#bad", startedAt: TA.startedAt, trace: "{not json" };
    await expect(tracesOf(client({ [A]: [item(TA), bad] }), "t1", [A])).rejects.toThrow(
      `Unreadable trace bad in conversation ${A}`,
    );
  });

  it("returns none for no conversations", async () => {
    await expect(tracesOf(client({}), "t1", [])).resolves.toEqual([]);
  });
});
