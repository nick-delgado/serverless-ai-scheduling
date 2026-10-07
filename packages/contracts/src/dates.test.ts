import { describe, expect, it } from "vitest";

import { addDays, clinicDateOf, parseIsoDate, toInstantMs, toZonedParts, weekdayOf } from "./dates";

describe("clinic-date helpers (America/New_York)", () => {
  it("clinicDateOf uses the clinic's calendar, not UTC's", () => {
    expect(clinicDateOf("2026-10-14T03:30:00Z")).toBe("2026-10-13"); // 11:30 PM ET on the 13th
    expect(clinicDateOf("2026-10-14T04:00:00Z")).toBe("2026-10-14");
  });

  it("clinicDateOf zero-pads the month and day, takes a Date, and honours another time zone", () => {
    expect(clinicDateOf(new Date("2026-03-01T12:00:00Z"))).toBe("2026-03-01");
    expect(clinicDateOf("2026-10-14T03:30:00Z", "UTC")).toBe("2026-10-14");
  });

  it("addDays and weekdayOf do calendar arithmetic", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekdayOf("2026-10-05")).toBe(1); // Monday
    expect(weekdayOf("2026-11-01")).toBe(0); // Sunday
  });

  it("toZonedParts reads every wall-clock field, on the clinic's clock by default", () => {
    // Sun Nov 1, 11:30:15 PM EST is already Monday in UTC.
    expect(toZonedParts(new Date("2026-11-02T04:30:15Z"))).toEqual({
      year: 2026,
      month: 11,
      day: 1,
      hour: 23,
      minute: 30,
      second: 15,
      weekday: 0,
    });
    expect(toZonedParts(new Date("2026-11-02T04:30:15Z"), "UTC")).toMatchObject({
      day: 2,
      hour: 4,
      weekday: 1,
    });
    expect(toZonedParts(new Date("2026-10-05T17:00:00Z")).hour).toBe(13); // 1 PM EDT, on a 24-hour clock
  });

  it("parseIsoDate splits a calendar date and rejects anything else", () => {
    expect(parseIsoDate("2026-11-02")).toEqual([2026, 11, 2]);
    expect(() => parseIsoDate("2026-02-30")).toThrow(RangeError);
    expect(() => addDays("11/02/2026", 1)).toThrow(/expected YYYY-MM-DD/);
  });

  it("toInstantMs takes a Date or an ISO string, and rejects an invalid one", () => {
    const ms = Date.UTC(2026, 9, 5, 13);
    expect(toInstantMs("2026-10-05T13:00:00Z")).toBe(ms);
    expect(toInstantMs(new Date(ms))).toBe(ms);
    expect(() => toInstantMs("not a date")).toThrow(/Invalid instant: not a date/);
    expect(() => clinicDateOf(new Date(Number.NaN))).toThrow(RangeError);
  });
});
