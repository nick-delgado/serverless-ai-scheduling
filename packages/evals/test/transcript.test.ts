/**
 * `turnEvents`: how one agent turn's new messages become transcript events.
 */
import { SPOKEN_MESSAGE_MARKER, type LlmMessage } from "@sched/agent";
import { describe, expect, it } from "vitest";

import { textOf, turnEvents } from "../src";

describe("turnEvents", () => {
  it("leaves a spoken message's marker out of the patient's text (#234)", () => {
    const messages: LlmMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: SPOKEN_MESSAGE_MARKER },
          { type: "text", text: "doctor oh car" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Which doctor?" }] },
    ];
    expect(turnEvents(1, messages, [])[0]).toEqual({ kind: "patient", turn: 1, text: "doctor oh car" });
  });

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

  it("joins one message's visible text blocks with a blank line, as the patient saw them (#125)", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "reasoning", family: "anthropic.claude", modelId: "m", text: "hidden" },
          { type: "text", text: "Dr. Lee is free Tuesday." },
        ],
      },
    ];
    expect(turnEvents(1, messages, [])[1]).toEqual({
      kind: "assistant",
      turn: 1,
      text: "Let me check.\n\nDr. Lee is free Tuesday.",
    });
    // An empty block never reaches the patient (the loop and restore drop it too); a parsed TextBlock can't be empty.
    expect(
      textOf([
        { type: "text", text: "a" },
        { type: "text", text: "" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\n\nb");
  });
});
