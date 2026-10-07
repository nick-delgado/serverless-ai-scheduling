/**
 * Clinic-date helpers (#114): the one implementation of "which calendar day is it at the clinic" and plain
 * calendar arithmetic, shared by `@sched/tools` (re-exported from its `clock.ts`, where the UTC conversions
 * built on them stay) and the system prompt in `@sched/agent`, which can't import `@sched/tools`. Built on
 * `Intl` (Node 24 has no Temporal by default). The clinic's wall clock is `CLINIC.timezone`.
 */
import { CLINIC } from "./clinic";
import { IsoDate } from "./primitives";

/** A `Date` or an ISO-8601 instant string as epoch milliseconds; anything unparseable throws a RangeError. */
export function toInstantMs(instant: Date | string): number {
  const ms = typeof instant === "string" ? Date.parse(instant) : instant.getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid instant: ${String(instant)}`);
  return ms;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock reading of `instant` in `timeZone`. */
export function toZonedParts(instant: Date, timeZone: string = CLINIC.timezone): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of partsFormatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  const num = (type: string): number => Number(parts[type]);
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour") % 24, // some ICU builds render midnight as "24" even with h23
    minute: num("minute"),
    second: num("second"),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
  };
}

/** `[year, month (1-12), day]` of a `YYYY-MM-DD` calendar date; anything else throws a RangeError. */
export function parseIsoDate(date: string): [number, number, number] {
  const parsed = IsoDate.safeParse(date);
  if (!parsed.success) throw new RangeError(`Invalid date (expected YYYY-MM-DD): ${date}`);
  const [y, m, d] = parsed.data.split("-").map(Number);
  return [y ?? NaN, m ?? NaN, d ?? NaN];
}

/** Calendar date (`YYYY-MM-DD`) of `instant` on the clinic's wall clock. The "day" in ADR-004's AP-5 key. */
export function clinicDateOf(instant: Date | string, timeZone: string = CLINIC.timezone): IsoDate {
  const p = toZonedParts(new Date(toInstantMs(instant)), timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** `date` plus `days` calendar days (no time zone involved). */
export function addDays(date: string, days: number): IsoDate {
  const [y, m, d] = parseIsoDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Day of week of a calendar date: 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = parseIsoDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
