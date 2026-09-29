import { describe, expect, it } from "vitest";

import { ChatRequest } from "./api";
import { IsoDate, IsoDateTimeUtc } from "./primitives";
import { Slot } from "./domain";
import { makeSlotId, messageIdForSeq, parseSlotId, toCanonicalUtc } from "./ids";
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
