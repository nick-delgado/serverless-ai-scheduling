// @vitest-environment node
import { encodeStreamEvent, TOOL_STATUS_LABELS, type ChatStreamEvent, type ToolName } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import {
  confirmationProblems,
  describeTurn,
  escalationProblems,
  MAX_SCRIPT_TURNS,
  nextScriptMessage,
  readTurnBody,
  type TurnRecord,
  type WriteScript,
} from "./turns";

const CONV = "0f8d2c3a-5b6e-4f7a-8c9d-1e2f3a4b5c6d";
const MSG = "msg_000002";
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const status = (tool: ToolName): ChatStreamEvent => ({
  type: "status",
  tool,
  label: TOOL_STATUS_LABELS[tool],
});
const ndjson = (events: ChatStreamEvent[]) => events.map(encodeStreamEvent).join("");

describe("readTurnBody", () => {
  it("lists the status events' tools in order, repeats included, and takes the conversation from done", () => {
    const turn = readTurnBody(
      ndjson([
        status("check_availability"),
        { type: "text_delta", text: "Hello" },
        status("check_availability"),
        status("book_appointment"),
        { type: "done", conversationId: CONV, messageId: MSG, usage },
      ]),
    );
    expect(turn).toEqual({
      tools: ["check_availability", "check_availability", "book_appointment"],
      conversationId: CONV,
      text: "Hello",
    });
  });

  it("applies text_reset to the visible text", () => {
    const turn = readTurnBody(
      ndjson([
        { type: "text_delta", text: "Draft" },
        { type: "text_reset", keepChars: 0 },
        { type: "text_delta", text: "Final" },
        { type: "done", conversationId: CONV, messageId: MSG, usage },
      ]),
    );
    expect(turn.text).toBe("Final");
  });

  it("takes the conversation from the conversation event when the turn fails without one", () => {
    const turn = readTurnBody(
      ndjson([
        { type: "conversation", conversationId: CONV },
        { type: "error", code: "AGENT_UNAVAILABLE", message: "Try again.", retryable: true },
      ]),
    );
    expect(turn).toEqual({ tools: [], conversationId: CONV, errorCode: "AGENT_UNAVAILABLE", text: "" });
  });

  it("takes the conversation from an error event that names one", () => {
    const turn = readTurnBody(
      ndjson([
        {
          type: "error",
          code: "RATE_LIMITED",
          message: "Slow down.",
          retryable: false,
          conversationId: CONV,
        },
      ]),
    );
    expect(turn.conversationId).toBe(CONV);
    expect(turn.errorCode).toBe("RATE_LIMITED");
  });

  it("reads the buffered JSON array form", () => {
    const body = JSON.stringify([
      status("escalate_to_human"),
      { type: "done", conversationId: CONV, messageId: MSG, usage },
    ]);
    expect(readTurnBody(body).tools).toEqual(["escalate_to_human"]);
  });
});

const turn = (index: number, tools: ToolName[], extra: Partial<TurnRecord> = {}): TurnRecord => ({
  index,
  message: `message ${String(index)}`,
  tools,
  chips: tools.map((t) => TOOL_STATUS_LABELS[t]),
  text: "",
  ...extra,
});

describe("describeTurn", () => {
  it("prints the turn number, tools, chip count and error, never the text", () => {
    const line = describeTurn(
      turn(1, ["check_availability"], { text: "secret reply", errorCode: "INTERNAL" }),
    );
    expect(line).toBe("turn 2: tools [check_availability], 1 chip(s), error INTERNAL");
  });

  it("says none for a turn without tools", () => {
    expect(describeTurn(turn(0, []))).toBe("turn 1: tools [none], 0 chip(s)");
  });
});

const script: WriteScript = { request: "R", choose: "C", confirm: "Y" };

describe("nextScriptMessage", () => {
  it("sends the request, then the choice, then the confirmation", () => {
    expect(nextScriptMessage(script, [], "book_appointment")).toBe("R");
    expect(nextScriptMessage(script, [turn(0, [])], "book_appointment")).toBe("C");
    expect(nextScriptMessage(script, [turn(0, []), turn(1, [])], "book_appointment")).toBe("Y");
  });

  it("repeats the confirmation while the write hasn't run, up to the turn cap", () => {
    const five = [0, 1, 2, 3, 4].map((i) => turn(i, []));
    expect(nextScriptMessage(script, five, "book_appointment")).toBe("Y");
    const six = [...five, turn(5, [])];
    expect(six).toHaveLength(MAX_SCRIPT_TURNS);
    expect(nextScriptMessage(script, six, "book_appointment")).toBeUndefined();
  });

  it("stops once the write ran, even before the confirmation", () => {
    expect(nextScriptMessage(script, [turn(0, ["book_appointment"])], "book_appointment")).toBeUndefined();
    expect(
      nextScriptMessage(
        script,
        [turn(0, []), turn(1, []), turn(2, ["book_appointment"])],
        "book_appointment",
      ),
    ).toBeUndefined();
  });

  it("doesn't stop for another tool", () => {
    expect(nextScriptMessage(script, [turn(0, ["check_availability"])], "book_appointment")).toBe("C");
  });

  it("stops after a failed turn", () => {
    expect(
      nextScriptMessage(script, [turn(0, [], { errorCode: "INTERNAL" })], "book_appointment"),
    ).toBeUndefined();
  });
});

describe("confirmationProblems", () => {
  const ok = [turn(0, ["find_providers", "check_availability"]), turn(1, []), turn(2, ["book_appointment"])];

  it("passes a write that runs once, in the confirmation's turn, with its chip", () => {
    expect(confirmationProblems(ok, "book_appointment")).toEqual([]);
  });

  it("passes a write in a repeated confirmation's turn", () => {
    const later = [turn(0, []), turn(1, []), turn(2, []), turn(3, ["book_appointment"])];
    expect(confirmationProblems(later, "book_appointment")).toEqual([]);
  });

  it("fails a write before the confirmation", () => {
    const early = [turn(0, []), turn(1, ["book_appointment"])];
    expect(confirmationProblems(early, "book_appointment")).toEqual([
      "book_appointment ran in turn 2, before the confirmation",
      "book_appointment ran 0 time(s) from the confirmation on; expected exactly 1",
    ]);
  });

  it("fails a write in the request's turn", () => {
    expect(
      confirmationProblems(
        [turn(0, ["book_appointment"]), turn(1, []), turn(2, ["book_appointment"])],
        "book_appointment",
      ),
    ).toEqual(["book_appointment ran in turn 1, before the confirmation"]);
  });

  it("fails no write at all", () => {
    expect(confirmationProblems([turn(0, []), turn(1, []), turn(2, [])], "book_appointment")).toEqual([
      "book_appointment ran 0 time(s) from the confirmation on; expected exactly 1",
    ]);
  });

  it("fails two writes after the confirmation", () => {
    const twice = [turn(0, []), turn(1, []), turn(2, ["book_appointment", "book_appointment"])];
    expect(confirmationProblems(twice, "book_appointment")).toEqual([
      "book_appointment ran 2 time(s) from the confirmation on; expected exactly 1",
    ]);
  });

  it("fails a write whose chip the page never showed", () => {
    const hidden = [
      turn(0, []),
      turn(1, []),
      turn(2, ["book_appointment"], { chips: ["Checking availability…"] }),
    ];
    expect(confirmationProblems(hidden, "book_appointment")).toEqual([
      'turn 3 ran book_appointment but showed no "Booking your appointment…" chip',
    ]);
  });

  it("checks the tool it's given, with that tool's label", () => {
    const moved = [turn(0, []), turn(1, []), turn(2, ["reschedule_appointment"], { chips: [] })];
    expect(confirmationProblems(moved, "reschedule_appointment")).toEqual([
      'turn 3 ran reschedule_appointment but showed no "Rescheduling your appointment…" chip',
    ]);
    expect(confirmationProblems(moved, "book_appointment")).toEqual([
      "book_appointment ran 0 time(s) from the confirmation on; expected exactly 1",
    ]);
  });

  it("fails a turn that ended with an error", () => {
    const failed = [...ok.slice(0, 2), turn(2, ["book_appointment"], { errorCode: "INTERNAL" })];
    expect(confirmationProblems(failed, "book_appointment")).toEqual(["turn 3 ended with INTERNAL"]);
  });
});

describe("escalationProblems", () => {
  const PHONE = "1-800-555-0199";

  it("passes escalate_to_human in the request's turn, with its chip and the number", () => {
    expect(escalationProblems(turn(0, ["escalate_to_human"], { text: `Call ${PHONE}.` }), PHONE)).toEqual([]);
  });

  it("fails a turn without escalate_to_human", () => {
    expect(escalationProblems(turn(0, ["get_patient_profile"], { text: PHONE }), PHONE)).toEqual([
      "escalate_to_human didn't run in the request's turn",
    ]);
  });

  it("fails a missing chip", () => {
    expect(escalationProblems(turn(0, ["escalate_to_human"], { text: PHONE, chips: [] }), PHONE)).toEqual([
      'no "Contacting the front desk…" chip',
    ]);
  });

  it("fails a reply without the number", () => {
    expect(escalationProblems(turn(0, ["escalate_to_human"], { text: "Someone will call." }), PHONE)).toEqual(
      ["the reply doesn't give the front desk's number"],
    );
  });

  it("fails a turn that ended with an error", () => {
    expect(
      escalationProblems(
        turn(0, ["escalate_to_human"], { text: PHONE, errorCode: "AGENT_UNAVAILABLE" }),
        PHONE,
      ),
    ).toEqual(["the turn ended with AGENT_UNAVAILABLE"]);
  });
});
