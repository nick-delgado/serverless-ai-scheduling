/**
 * Restore shows what the patient saw live (`lib/display.ts`): text only, one assistant bubble per
 * stretch between patient messages, joined like the stream joins text blocks.
 */
import { TEXT_BLOCK_SEPARATOR } from "@sched/agent";
import { DisplayMessage, type ContentBlock, type ConversationMessage } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { DISPLAY_TEXT_SEPARATOR, toDisplayMessages } from "../src/lib/display";

const CONV = "00000000-0000-4000-8000-0000000000c1";
const TURN = "00000000-0000-4000-8000-0000000000d1";

let seq = 0;
function msg(role: "user" | "assistant", content: ContentBlock[], second = seq): ConversationMessage {
  const m: ConversationMessage = {
    conversationId: CONV,
    seq,
    role,
    content,
    turnId: TURN,
    createdAt: `2026-10-05T13:00:${String(second).padStart(2, "0")}.000Z`,
  };
  seq += 1;
  return m;
}
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const toolUse: ContentBlock = {
  type: "tool_use",
  id: "tooluse_1",
  name: "get_my_appointments",
  input: { include_past: false },
};
const toolResult: ContentBlock = {
  type: "tool_result",
  toolUseId: "tooluse_1",
  content: '{"ok":true,"data":{"appointments":[]}}',
  isError: false,
};
const reasoning: ContentBlock = {
  type: "reasoning",
  family: "anthropic.claude",
  modelId: "us.anthropic.claude-sonnet-4-6",
  text: "SECRET-REASONING",
  signature: "sig",
};

describe("toDisplayMessages", () => {
  it("joins text blocks with the agent loop's separator", () => {
    expect(DISPLAY_TEXT_SEPARATOR).toBe(TEXT_BLOCK_SEPARATOR);
  });

  it("shows a tool-using turn as one patient bubble and one assistant bubble, text only", () => {
    seq = 0;
    const messages = [
      msg("user", [text("When is my appointment?")]),
      msg("assistant", [reasoning, text("Let me check."), toolUse]),
      msg("user", [toolResult]),
      msg("assistant", [reasoning, text("You have no upcoming appointments.")]),
    ];
    const display = toDisplayMessages(messages);
    expect(display).toEqual([
      {
        id: "msg_000000",
        role: "patient",
        text: "When is my appointment?",
        createdAt: "2026-10-05T13:00:00.000Z",
      },
      {
        // The stored reply's ID and time: the same messageId the live `done` event carried.
        id: "msg_000003",
        role: "assistant",
        text: "Let me check.\n\nYou have no upcoming appointments.",
        createdAt: "2026-10-05T13:00:03.000Z",
      },
    ]);
    for (const m of display) DisplayMessage.parse(m);
    const json = JSON.stringify(display);
    expect(json).not.toContain("SECRET-REASONING");
    expect(json).not.toContain("get_my_appointments");
    expect(json).not.toContain('appointments\\":[]');
  });

  it("starts a new assistant bubble after each patient message", () => {
    seq = 0;
    const display = toDisplayMessages([
      msg("user", [text("Hi")]),
      msg("assistant", [text("Hello!")]),
      msg("user", [text("Book me in")]),
      msg("assistant", [text("Sure.")]),
    ]);
    expect(display.map((d) => [d.id, d.role, d.text])).toEqual([
      ["msg_000000", "patient", "Hi"],
      ["msg_000001", "assistant", "Hello!"],
      ["msg_000002", "patient", "Book me in"],
      ["msg_000003", "assistant", "Sure."],
    ]);
  });

  it("skips empty text blocks, so no stray separator appears", () => {
    seq = 0;
    const display = toDisplayMessages([
      msg("user", [text("Hi")]),
      msg("assistant", [text(""), toolUse]),
      msg("user", [toolResult]),
      msg("assistant", [text("Hello!")]),
    ]);
    expect(display.at(-1)).toMatchObject({ id: "msg_000003", text: "Hello!" });
  });

  it("takes the bubble's id and time from its last message with text, not a later tool-only one", () => {
    seq = 0;
    const display = toDisplayMessages([
      msg("user", [text("Hi")]),
      msg("assistant", [text("Checking."), toolUse]),
      msg("user", [toolResult]),
      msg("assistant", [toolUse]),
    ]);
    expect(display.at(-1)).toEqual({
      id: "msg_000001",
      role: "assistant",
      text: "Checking.",
      createdAt: "2026-10-05T13:00:01.000Z",
    });
  });

  it("shows no assistant bubble for a stretch without text", () => {
    seq = 0;
    const display = toDisplayMessages([msg("user", [text("Hi")]), msg("assistant", [reasoning, toolUse])]);
    expect(display.map((d) => d.role)).toEqual(["patient"]);
  });

  it("attaches a closing reply stored at the start of the next turn to the turn it closes", () => {
    seq = 0;
    const display = toDisplayMessages([
      msg("user", [text("Hi")]),
      msg("assistant", [toolUse]),
      msg("user", [toolResult]),
      // The next turn first closes the interrupted one (lib/history.ts), then stores the new message.
      msg("assistant", [text("Sorry, something went wrong.")]),
      msg("user", [text("Try again")]),
    ]);
    expect(display.map((d) => [d.id, d.role, d.text])).toEqual([
      ["msg_000000", "patient", "Hi"],
      ["msg_000003", "assistant", "Sorry, something went wrong."],
      ["msg_000004", "patient", "Try again"],
    ]);
  });

  it("joins a patient message's text blocks the same way", () => {
    seq = 0;
    expect(toDisplayMessages([msg("user", [text("Hi"), toolResult, text("again")])])).toEqual([
      { id: "msg_000000", role: "patient", text: "Hi\n\nagain", createdAt: "2026-10-05T13:00:00.000Z" },
    ]);
  });

  it("returns nothing for no messages", () => {
    expect(toDisplayMessages([])).toEqual([]);
  });
});
