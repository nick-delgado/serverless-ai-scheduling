import { EXAMPLES } from "@sched/contracts/testing";
import { describe, expect, it } from "vitest";

import {
  clinicDateOf,
  clinicDateRangeUtc,
  formatClinicDateTime,
  FrozenClock,
  startsAfter,
  SystemClock,
  toZonedParts,
  utcOffsetMinutes,
  zonedTimeToUtc,
  type Clock,
} from "../src/clock";

const at = (date: string, hour: number, minute = 0): string =>
  zonedTimeToUtc(date, { hour, minute }).toISOString();

describe("Clock", () => {
  it("SystemClock reads real time", () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("FrozenClock stands still until moved", () => {
    const clock: Clock = new FrozenClock("2026-10-05T13:00:00Z");
    expect(clock.now().toISOString()).toBe("2026-10-05T13:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-10-05T13:00:00.000Z");
  });

  it("FrozenClock advances by milliseconds or a duration, and can be set", () => {
    const clock = new FrozenClock(new Date("2026-10-05T13:00:00Z"));
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe("2026-10-05T13:00:01.500Z");
    clock.advance({ days: 1, hours: 2, minutes: 3, seconds: 4, milliseconds: -500 });
    expect(clock.now().toISOString()).toBe("2026-10-06T15:03:05.000Z");
    clock.set("2026-11-02T13:00:00Z");
    expect(clock.now().toISOString()).toBe("2026-11-02T13:00:00.000Z");
  });

  it("FrozenClock hands out copies, so callers can't move it by mutating a Date", () => {
    const clock = new FrozenClock("2026-10-05T13:00:00Z");
    clock.now().setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-10-05T13:00:00.000Z");
  });

  it("FrozenClock rejects invalid instants", () => {
    expect(() => new FrozenClock("not a date")).toThrow(RangeError);
    expect(() => new FrozenClock("2026-10-05T13:00:00Z").advance(Number.NaN)).toThrow(RangeError);
  });
});

describe("startsAfter (the bookable rule, #77)", () => {
  const now = new Date("2026-10-05T13:00:00Z");

  it("is false for a start equal to now: that slot or appointment has already started", () => {
    expect(startsAfter("2026-10-05T13:00:00Z", now)).toBe(false);
  });

  it("is true for a start 1 ms after now", () => {
    expect(startsAfter("2026-10-05T13:00:00.001Z", now)).toBe(true);
  });

  it("is false for a start before now", () => {
    expect(startsAfter("2026-10-05T12:59:59.999Z", now)).toBe(false);
  });
});

describe("clinic time (America/New_York)", () => {
  describe("DST end, Sunday Nov 1, 2026 (EDT −4 → EST −5)", () => {
    it("uses −4 before and −5 after the 2 AM transition (06:00Z)", () => {
      expect(utcOffsetMinutes(new Date("2026-11-01T05:59:00Z"))).toBe(-240);
      expect(utcOffsetMinutes(new Date("2026-11-01T06:00:00Z"))).toBe(-300);
    });

    it("converts clinic hours on both sides of the boundary", () => {
      // Friday before: EDT
      expect(at("2026-10-30", 8)).toBe("2026-10-30T12:00:00.000Z");
      expect(at("2026-10-30", 16, 30)).toBe("2026-10-30T20:30:00.000Z");
      // Monday after: EST
      expect(at("2026-11-02", 8)).toBe("2026-11-02T13:00:00.000Z");
      expect(at("2026-11-02", 16, 30)).toBe("2026-11-02T21:30:00.000Z");
    });

    it("resolves the repeated 1 AM hour to its first (EDT) occurrence", () => {
      expect(at("2026-11-01", 1, 30)).toBe("2026-11-01T05:30:00.000Z");
    });
  });

  describe("DST start, Sunday Mar 14, 2027 (EST −5 → EDT −4)", () => {
    it("converts clinic hours on both sides of the boundary", () => {
      expect(at("2027-03-12", 8)).toBe("2027-03-12T13:00:00.000Z");
      expect(at("2027-03-15", 8)).toBe("2027-03-15T12:00:00.000Z");
    });

    it("rejects wall times in the skipped hour", () => {
      expect(() => at("2027-03-14", 2, 30)).toThrow(/does not exist/);
      expect(at("2027-03-14", 3)).toBe("2027-03-14T07:00:00.000Z");
    });
  });

  it("round-trips every half hour of a clinic day through toZonedParts", () => {
    for (const date of ["2026-10-13", "2026-11-03", "2027-01-15", "2027-07-01"]) {
      for (let m = 8 * 60; m < 17 * 60; m += 30) {
        const utc = zonedTimeToUtc(date, { hour: Math.floor(m / 60), minute: m % 60 });
        const p = toZonedParts(utc);
        expect([p.hour, p.minute]).toEqual([Math.floor(m / 60), m % 60]);
        expect(clinicDateOf(utc)).toBe(date);
      }
    }
  });

  it("rejects malformed dates and times", () => {
    expect(() => zonedTimeToUtc("2026-02-30", { hour: 8, minute: 0 })).toThrow(RangeError);
    expect(() => zonedTimeToUtc("2026-10-13", { hour: 24, minute: 0 })).toThrow(RangeError);
    expect(() => zonedTimeToUtc("2026-10-13", { hour: 8, minute: 7.5 })).toThrow(RangeError);
  });

  it("clinicDateRangeUtc covers local midnight to the local midnight after the end date", () => {
    expect(clinicDateRangeUtc("2026-10-13", "2026-10-13")).toEqual({
      fromUtc: "2026-10-13T04:00:00.000Z",
      toUtc: "2026-10-14T04:00:00.000Z",
    });
    // Spans the DST change: the range is 25 hours longer than it looks in UTC terms.
    expect(clinicDateRangeUtc("2026-10-31", "2026-11-01")).toEqual({
      fromUtc: "2026-10-31T04:00:00.000Z",
      toUtc: "2026-11-02T05:00:00.000Z",
    });
    expect(() => clinicDateRangeUtc("2026-10-14", "2026-10-13")).toThrow(RangeError);
  });

  it("formatClinicDateTime produces the contracts' start_local shape", () => {
    expect(formatClinicDateTime(EXAMPLES.SlotOption.start_utc)).toBe(EXAMPLES.SlotOption.start_local);
    expect(formatClinicDateTime("2026-10-15T14:00:00Z")).toBe("Thursday, October 15, 2026 at 10:00 AM ET");
    expect(formatClinicDateTime("2026-11-02T13:00:00Z")).toBe("Monday, November 2, 2026 at 8:00 AM ET");
    expect(formatClinicDateTime(new Date("2026-11-02T17:00:00Z"))).toBe(
      "Monday, November 2, 2026 at 12:00 PM ET",
    );
  });
});
