/**
 * Time, injected (CLAUDE.md rule 3). Tools and repositories never call `new Date()` themselves; they ask
 * a `Clock`, so the eval harness can run a whole conversation at a frozen instant (ADR-008).
 *
 * Also: clinic-time helpers built on `Intl` (Node 24 has no Temporal by default). Stored
 * timestamps are UTC (ADR-004); the clinic's wall clock is `CLINIC.timezone` (America/New_York),
 * which observes DST, so wall-time <-> UTC conversion must use the offset in effect on that date.
 */
import { addDays, CLINIC, parseIsoDate, toInstantMs, toZonedParts } from "@sched/contracts";

// The clinic-date helpers live in @sched/contracts (#114), so the system prompt in @sched/agent shares them;
// re-exported here so callers keep importing them from @sched/tools.
export { addDays, clinicDateOf, toZonedParts, weekdayOf, type ZonedParts } from "@sched/contracts";

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

/**
 * The bookable rule, shared by the tools so it can't drift between them (#77): a slot or appointment
 * that starts strictly after `now` hasn't started; one that starts at `now` already has. `now` is the
 * caller's single `ctx.clock.now()` read, so every comparison in one tool call uses the same instant.
 */
export function startsAfter(startUtc: string, now: Date): boolean {
  return Date.parse(startUtc) > now.getTime();
}

// ---------------------------------------------------------------------------------------------
// Clinic time (wall clock in a named IANA zone)
// ---------------------------------------------------------------------------------------------

/** Offset of `timeZone` from UTC at `instant`, in minutes (America/New_York: -240 in EDT, -300 in EST). */
export function utcOffsetMinutes(instant: Date, timeZone: string = CLINIC.timezone): number {
  const p = toZonedParts(instant, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((wallAsUtc - wholeSecond) / 60_000);
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
