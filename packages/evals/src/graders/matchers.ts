/**
 * Argument matchers (scenarios/README.md "Argument matchers") and the appointment matcher used by
 * end-state grading. Both return the first mismatch as a readable reason, or `undefined` on a match.
 */
import { CLINIC, type Appointment } from "@sched/contracts";
import { clinicDateOf, toZonedParts } from "@sched/tools";

import type { AppointmentMatcher, ArgMatcher, ArgsSubset, Weekday } from "../schema";
import { WEEKDAYS } from "../schema";
import { includesCi } from "./text";

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function matchValue(expected: ArgMatcher, actual: unknown, path: string): string | undefined {
  if (isRecord(expected)) {
    if ("one_of" in expected && Array.isArray(expected.one_of)) {
      return expected.one_of.some((v) => Object.is(v, actual) || JSON.stringify(v) === JSON.stringify(actual))
        ? undefined
        : `${path}: ${JSON.stringify(actual)} is not one of ${JSON.stringify(expected.one_of)}`;
    }
    if ("contains_ci" in expected && typeof expected.contains_ci === "string") {
      return typeof actual === "string" && includesCi(actual, expected.contains_ci)
        ? undefined
        : `${path}: ${JSON.stringify(actual)} does not contain "${expected.contains_ci}"`;
    }
    if (!isRecord(actual)) return `${path}: expected an object, got ${JSON.stringify(actual)}`;
    return matchArgs(expected as ArgsSubset, actual, path);
  }
  return Object.is(expected, actual)
    ? undefined
    : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

/** `actual` contains `subset` (recursively), with matcher objects applied. */
export function matchArgs(subset: ArgsSubset, actual: unknown, path = "args"): string | undefined {
  if (!isRecord(actual)) return `${path}: expected an object, got ${JSON.stringify(actual)}`;
  for (const [key, expected] of Object.entries(subset)) {
    const reason = matchValue(expected, actual[key], `${path}.${key}`);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/** Every string anywhere inside a value (keys included), for "must not appear" checks. */
export function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (isRecord(value))
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allStrings(v, out);
    }
  return out;
}

const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** Local (clinic timezone) facts about an appointment's start: comparable strings plus their numeric parts. */
export function localFacts(startUtc: string): {
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:MM`, 24-hour */
  time: string;
  weekday: Weekday;
  utcTime: string;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const start = new Date(startUtc);
  const p = toZonedParts(start, CLINIC.timezone);
  return {
    date: clinicDateOf(start),
    time: hhmm(p.hour, p.minute),
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    // p.weekday is 0 (Sunday) to 6, so the index is always in range.
    weekday: WEEKDAYS[(p.weekday + 6) % 7] as Weekday,
    utcTime: hhmm(start.getUTCHours(), start.getUTCMinutes()),
  };
}

/** Check one appointment against a matcher. `firstFailedBook` resolves `not_slot: first_failed_book`. */
export function matchAppointment(
  m: AppointmentMatcher,
  appt: Appointment,
  firstFailedBook: string | undefined,
): string | undefined {
  const f = localFacts(appt.startUtc);
  const checks: [boolean, string][] = [
    [
      m.appointment_id === undefined || appt.appointmentId === m.appointment_id,
      `appointment_id is ${appt.appointmentId}`,
    ],
    [m.provider_id === undefined || appt.providerId === m.provider_id, `provider is ${appt.providerId}`],
    [
      m.provider_in === undefined || m.provider_in.includes(appt.providerId),
      `provider ${appt.providerId} not allowed`,
    ],
    [m.specialty === undefined || appt.specialty === m.specialty, `specialty is ${appt.specialty}`],
    [
      m.specialty_in === undefined || m.specialty_in.includes(appt.specialty),
      `specialty ${appt.specialty} not allowed`,
    ],
    [m.local_date === undefined || f.date === m.local_date, `local date is ${f.date}`],
    [
      m.local_date_between === undefined ||
        (f.date >= m.local_date_between[0] && f.date <= m.local_date_between[1]),
      `local date ${f.date} is outside ${m.local_date_between?.join("..") ?? ""}`,
    ],
    [m.weekday_in === undefined || m.weekday_in.includes(f.weekday), `weekday is ${f.weekday}`],
    [m.weekday_not_in === undefined || !m.weekday_not_in.includes(f.weekday), `weekday is ${f.weekday}`],
    [m.local_time === undefined || f.time === m.local_time, `local time is ${f.time}`],
    [
      m.local_time_after === undefined || f.time >= m.local_time_after,
      `local time ${f.time} is before ${m.local_time_after ?? ""}`,
    ],
    [
      m.local_time_before === undefined || f.time < m.local_time_before,
      `local time ${f.time} is not before ${m.local_time_before ?? ""}`,
    ],
    [m.start_utc_time === undefined || f.utcTime === m.start_utc_time, `UTC start time is ${f.utcTime}`],
    [
      m.reason_contains_any === undefined || m.reason_contains_any.some((r) => includesCi(appt.reason, r)),
      `reason "${appt.reason}" has none of ${JSON.stringify(m.reason_contains_any)}`,
    ],
    [
      m.not_slot === undefined ||
        appt.slotId !== (m.not_slot === "first_failed_book" ? firstFailedBook : m.not_slot),
      `slot ${appt.slotId} is forbidden (${m.not_slot ?? ""})`,
    ],
  ];
  return checks.find(([ok]) => !ok)?.[1];
}
