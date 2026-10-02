/**
 * `turnEvents`: how one agent turn's new messages become transcript events.
 */
import type { LlmMessage } from "@sched/agent";
import { describe, expect, it } from "vitest";

import { turnEvents } from "../src";

describe("turnEvents", () => {
  it("emits the patient's message, but no empty patient event for a tool-result message (8c21660/TEST-302)", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: [{ type: "text", text: "what's my next appointment?" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "get_my_appointments", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "tu_1", content: '{"appointments":[]}' }] },
      { role: "assistant", content: [{ type: "text", text: "You have no upcoming appointments." }] },
    ];
    const trace = [
      { toolUseId: "tu_1", name: "get_my_appointments", known: true, input: {}, ok: true, durationMs: 1 },
    ];
    const events = turnEvents(1, messages, trace, 1);
    expect(events.map((e) => e.kind)).toEqual(["patient", "tool_call", "assistant"]);
    expect(events[0]).toEqual({
      kind: "patient",
      turn: 1,
      text: "what's my next appointment?",
      scriptStep: 1,
    });
  });
});
