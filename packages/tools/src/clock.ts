/**
 * Time, injected (CLAUDE.md rule 3). Tools and repositories never call `new Date()` themselves; they ask
 * a `Clock`, so the eval harness can run a whole conversation at a frozen instant (ADR-008).
 *
 * Also: small clinic-time helpers built on `Intl` (Node 24 has no Temporal by default). Stored
 * timestamps are UTC (ADR-004); the clinic's wall clock is `CLINIC.timezone` (America/New_York),
 * which observes DST, so wall-time <-> UTC conversion must use the offset in effect on that date.
 */
import { CLINIC, IsoDate } from "@sched/contracts";

/** The agreed seam with the agent loop (#15): `now()` and nothing else. */
export interface Clock {
  now(): Date;
}

/** Real time. Production handlers use this. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export interface Duration {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}

const MS = { days: 86_400_000, hours: 3_600_000, minutes: 60_000, seconds: 1000, milliseconds: 1 } as const;

function toInstantMs(instant: Date | string): number {
  const ms = typeof instant === "string" ? Date.parse(instant) : instant.getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid instant: ${String(instant)}`);
  return ms;
}

/** A clock that only moves when told to. Tests and evals use it. `now()` returns a fresh Date each call. */
export class FrozenClock implements Clock {
  #ms: number;

  constructor(start: Date | string) {
    this.#ms = toInstantMs(start);
  }

  now(): Date {
    return new Date(this.#ms);
  }

  /** Jump to an absolute instant. */
  set(instant: Date | string): void {
    this.#ms = toInstantMs(instant);
  }

  /** Move forward (or back, with negative values) by a number of milliseconds or a duration. */
  advance(by: number | Duration): void {
    const delta =
      typeof by === "number"
        ? by
        : Object.entries(by).reduce((sum, [unit, n]) => sum + (n as number) * MS[unit as keyof Duration], 0);
    if (!Number.isFinite(delta)) throw new RangeError(`Invalid duration: ${JSON.stringify(by)}`);
    this.#ms += delta;
  }
}

// ---------------------------------------------------------------------------------------------
// Clinic time (wall clock in a named IANA zone)
// ---------------------------------------------------------------------------------------------

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

/** Offset of `timeZone` from UTC at `instant`, in minutes (America/New_York: -240 in EDT, -300 in EST). */
export function utcOffsetMinutes(instant: Date, timeZone: string = CLINIC.timezone): number {
  const p = toZonedParts(instant, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((wallAsUtc - wholeSecond) / 60_000);
}

function parseIsoDate(date: string): [number, number, number] {
  const parsed = IsoDate.safeParse(date);
  if (!parsed.success) throw new RangeError(`Invalid date (expected YYYY-MM-DD): ${date}`);
  const [y, m, d] = parsed.data.split("-").map(Number);
  return [y ?? NaN, m ?? NaN, d ?? NaN];
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads `date` `hour:minute`.
 *
 * Two-pass offset lookup: guess with the offset at the naive instant, then re-check with the offset at
 * the result (they differ only near a DST transition). Wall times that don't exist (the spring-forward
 * gap) throw; ambiguous ones (the fall-back hour) resolve to the earlier instant. Clinic hours never
 * touch either case in America/New_York, whose transitions happen at 2 AM.
 */
export function zonedTimeToUtc(
  date: string,
  time: { hour: number; minute: number },
  timeZone: string = CLINIC.timezone,
): Date {
  const [y, m, d] = parseIsoDate(date);
  const { hour, minute } = time;
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new RangeError(`Invalid wall time: ${hour}:${minute}`);
  }
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const firstOffset = utcOffsetMinutes(new Date(wall), timeZone);
  let utc = wall - firstOffset * 60_000;
  const secondOffset = utcOffsetMinutes(new Date(utc), timeZone);
  if (secondOffset !== firstOffset) utc = wall - secondOffset * 60_000;

  const check = toZonedParts(new Date(utc), timeZone);
  if (
    check.year !== y ||
    check.month !== m ||
    check.day !== d ||
    check.hour !== hour ||
    check.minute !== minute
  ) {
    const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    throw new RangeError(`${date} ${hhmm} does not exist in ${timeZone} (DST gap)`);
  }
  return new Date(utc);
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

/**
 * Half-open UTC range `[fromUtc, toUtc)` covering clinic-local days `startDate`..`endDate` inclusive,
 * i.e. local midnight of `startDate` to local midnight after `endDate`. Feeds AP-4 range queries.
 */
export function clinicDateRangeUtc(
  startDate: string,
  endDate: string,
  timeZone: string = CLINIC.timezone,
): { fromUtc: string; toUtc: string } {
  if (endDate < startDate) throw new RangeError(`endDate ${endDate} is before startDate ${startDate}`);
  return {
    fromUtc: zonedTimeToUtc(startDate, { hour: 0, minute: 0 }, timeZone).toISOString(),
    toUtc: zonedTimeToUtc(addDays(endDate, 1), { hour: 0, minute: 0 }, timeZone).toISOString(),
  };
}

const displayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: CLINIC.timezone,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * The model-facing local time, e.g. "Tuesday, October 13, 2026 at 2:30 PM ET" (the `start_local` shape
 * in @sched/contracts). Assembled from parts rather than `format()`, because ICU versions disagree on the
 * joiner (", " vs " at ") and on the space before AM/PM (some CLDR releases emit U+202F).
 */
export function formatClinicDateTime(instant: Date | string): string {
  const parts: Record<string, string> = {};
  for (const p of displayFormatter.formatToParts(new Date(toInstantMs(instant)))) parts[p.type] = p.value;
  const { weekday, month, day, year, hour, minute, dayPeriod } = parts;
  return `${weekday}, ${month} ${day}, ${year} at ${hour}:${minute} ${dayPeriod?.toUpperCase()} ${CLINIC.timezoneAbbrev}`;
}
