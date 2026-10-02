import { describe, expect, it } from "vitest";

import * as C from "./index";

import { ChatRequest } from "./api";
import { IsoDate, IsoDateTimeUtc } from "./primitives";
import { Slot } from "./domain";
import { RescheduleAppointmentOutput } from "./tools";
import { PatientId, makeSlotId, messageIdForSeq, parseSlotId, toCanonicalUtc } from "./ids";
import {
  ChatStreamEvent,
  ChatStreamEventList,
  encodeStreamEvent,
  parseChatResponseBody,
  parseStreamEventLine,
} from "./stream";
import { EXAMPLES } from "./testing/examples";

describe("slot IDs", () => {
  it("encode and decode the provider and start time", () => {
    const id = makeSlotId("prov_lee", "2026-10-13T18:30:00Z");
    expect(id).toBe("slot_lee_20261013T1830Z");
    expect(parseSlotId(id)).toEqual({ providerId: "prov_lee", startUtc: "2026-10-13T18:30:00Z" });
  });

  it("handle provider slugs that contain underscores", () => {
    const id = makeSlotId("prov_de_la_cruz", new Date("2026-10-15T14:00:00Z"));
    expect(parseSlotId(id)).toEqual({ providerId: "prov_de_la_cruz", startUtc: "2026-10-15T14:00:00Z" });
  });

  it("reject malformed IDs and impossible times", () => {
    expect(parseSlotId("tuesday-2pm")).toBeNull();
    expect(parseSlotId("slot_lee_20261332T2500Z")).toBeNull();
  });

  it("require whole-minute instants", () => {
    expect(() => toCanonicalUtc("2026-10-13T18:30:15Z")).toThrow();
    expect(toCanonicalUtc("2026-10-13T18:30:00.000Z")).toBe("2026-10-13T18:30:00Z");
  });

  it("format message IDs from sequence numbers", () => {
    expect(messageIdForSeq(3)).toBe("msg_000003");
    expect(() => messageIdForSeq(-1)).toThrow();
  });
});

describe("primitives", () => {
  it("IsoDate rejects impossible dates and other formats", () => {
    expect(IsoDate.safeParse("2026-02-29").success).toBe(false); // 2026 is not a leap year
    expect(IsoDate.safeParse("2028-02-29").success).toBe(true);
    expect(IsoDate.safeParse("10/13/2026").success).toBe(false);
  });

  it("IsoDateTimeUtc requires UTC (no offsets)", () => {
    expect(IsoDateTimeUtc.safeParse("2026-10-13T18:30:00Z").success).toBe(true);
    expect(IsoDateTimeUtc.safeParse("2026-10-13T14:30:00-04:00").success).toBe(false);
  });
});

describe("domain rules", () => {
  it("a slot has an appointmentId exactly when it is BOOKED", () => {
    const { appointmentId: _omit, ...open } = EXAMPLES.Slot;
    expect(Slot.safeParse({ ...open, status: "OPEN" }).success).toBe(true);
    expect(Slot.safeParse({ ...open, status: "BOOKED" }).success).toBe(false);
    expect(Slot.safeParse({ ...EXAMPLES.Slot, status: "OPEN" }).success).toBe(false);
  });

  it("a slot must end after it starts", () => {
    expect(Slot.safeParse({ ...EXAMPLES.Slot, endUtc: EXAMPLES.Slot.startUtc }).success).toBe(false);
  });

  it("a reschedule answer has no previous time exactly when it is already_rescheduled", () => {
    const moved = EXAMPLES.RescheduleAppointmentOutput;
    const parse = (o: object) => RescheduleAppointmentOutput.safeParse({ ...moved, ...o }).success;
    expect(parse({})).toBe(true); // a real move, with its previous time
    expect(parse({ previous_start_local: null, already_rescheduled: true })).toBe(true); // a retry
    expect(parse({ previous_start_local: null, already_rescheduled: false })).toBe(false);
    expect(parse({ already_rescheduled: true })).toBe(false);
  });
});

describe("chat API", () => {
  it("trims message text and enforces the length limit", () => {
    expect(ChatRequest.parse({ ...EXAMPLES.ChatRequest, text: "  hi  " }).text).toBe("hi");
    expect(ChatRequest.safeParse({ ...EXAMPLES.ChatRequest, text: "   " }).success).toBe(false);
    expect(ChatRequest.safeParse({ ...EXAMPLES.ChatRequest, text: "x".repeat(2001) }).success).toBe(false);
  });

  it("never accepts a patient identifier in the request body", () => {
    expect(ChatRequest.safeParse({ ...EXAMPLES.ChatRequest, patientId: EXAMPLES.PatientId }).success).toBe(
      false,
    );
  });
});

describe("stream events (ADR-007)", () => {
  const events = EXAMPLES.ChatStreamEventList;

  it("encode as one NDJSON line per event and parse back", () => {
    for (const event of events) {
      const line = encodeStreamEvent(event);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n");
      expect(parseStreamEventLine(line)).toEqual(event);
    }
  });

  it("refuse to encode an event that breaks the contract", () => {
    expect(() => encodeStreamEvent({ type: "text_delta", text: "" })).toThrow();
  });

  it("reject unknown event types", () => {
    expect(ChatStreamEvent.safeParse({ type: "tool_result", text: "x" }).success).toBe(false);
  });

  it("parse a streamed NDJSON body and a buffered JSON array identically", () => {
    const ndjson = `${events.map((e) => encodeStreamEvent(e)).join("")}\n`;
    const buffered = JSON.stringify(events);
    expect(parseChatResponseBody(ndjson)).toEqual(events);
    expect(parseChatResponseBody(buffered)).toEqual(events);
  });

  it("require the buffered form to end with done or error", () => {
    expect(
      ChatStreamEventList.safeParse([EXAMPLES.ChatStatusEvent, EXAMPLES.ChatTextDeltaEvent]).success,
    ).toBe(false);
    expect(ChatStreamEventList.safeParse([EXAMPLES.ChatErrorEvent]).success).toBe(true);
  });
});

describe("contracts v1.1 (#60)", () => {
  it("traces a call to a tool the model invented, marked known: false", () => {
    const invented = { ...EXAMPLES.ToolCallTrace, name: "delete_all_appointments", known: false, ok: false };
    expect(C.ToolCallTrace.safeParse(invented).success).toBe(true);
    expect(C.ToolCallTrace.safeParse({ ...invented, known: true }).success).toBe(false);
    expect(
      C.ToolCallTrace.safeParse({ ...invented, name: "x".repeat(C.TRACE_TOOL_NAME_MAX + 1) }).success,
    ).toBe(false);
  });

  it("requires every field a content block lists, and rejects unknown block types", () => {
    expect(C.ContentBlock.safeParse({ type: "text", text: "" }).success).toBe(false);
    expect(C.ContentBlock.safeParse({ type: "tool_result", content: "{}" }).success).toBe(false);
    expect(C.ContentBlock.safeParse({ type: "reasoning", text: "no family tag" }).success).toBe(false);
    expect(C.ContentBlock.safeParse({ type: "thinking", thinking: "", signature: "s" }).success).toBe(false);
    // Unknown keys are tolerated (forward compatibility for stored rows).
    expect(C.ContentBlock.safeParse({ type: "text", text: "Hi", extra: null }).success).toBe(true);
  });

  it("visibleText applies text_reset truncation in order", () => {
    const events: C.ChatStreamEvent[] = [
      { type: "text_delta", text: "Let me check." },
      { type: "text_delta", text: "\n\nSure, " },
      { type: "text_reset", keepChars: 13 },
      { type: "text_delta", text: "\n\nDr. Lee is free." },
    ];
    expect(C.visibleText(events)).toBe("Let me check.\n\nDr. Lee is free.");
  });
});

describe("PatientId (the Cognito sub)", () => {
  it("accepts a real Cognito sub shape, which isn't always an RFC 9562 UUID", () => {
    // Synthetic, with the shape seen on the dev pool (#17): version digit 7, variant digit d.
    expect(PatientId.safeParse("0192f4c1-3a7b-7c2d-d4e5-f60718293a4b").success).toBe(true);
    expect(PatientId.safeParse(EXAMPLES.PatientId).success).toBe(true);
  });

  it.each([
    "",
    "not-a-uuid",
    "0192f4c1-3a7b-7c2d-d4e5-f60718293a4",
    "0192f4c1-3a7b-7c2d-d4e5-f60718293a4g",
    "../PATIENT#x",
  ])("rejects %j", (value) => {
    expect(PatientId.safeParse(value).success).toBe(false);
  });
});
