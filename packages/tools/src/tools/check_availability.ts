/**
 * check_availability (FR-030): open slots by provider or by specialty (one of them is required), within a
 * clinic-local date range, optionally mornings or afternoons only.
 *
 * Query paths (ADR-004):
 * - `provider_id` given → AP-4 `slots.listOpenByProvider` over the whole UTC range (one query).
 * - `specialty` only → AP-5, the sparse specialty+day index (`slots.listOpenBySpecialtyAndDay`), one clinic
 *   day at a time. Days are walked in order and the walk stops as soon as more than
 *   `LIMITS.availabilityMaxSlots` matches are in hand, so a typical request costs one or two queries, not 31.
 *   Providers not accepting new patients are left out of this path only (decision, PR #70 review):
 *   `SlotOption` has no acceptance flag, so the model couldn't warn a new patient. Asked for by
 *   `provider_id`, they are still offered.
 * - neither → INVALID_INPUT (decision, PR #70 review): a clinic-wide list mixes specialties the patient
 *   didn't ask for, so the hint sends the model back to ask what kind of visit or which provider.
 *
 * Times: `date_range` is clinic-local (ET) days, converted with `clinicDateRangeUtc` / `clinicDateOf`,
 * which use the offset in effect on each day (the fixture window crosses the Nov 1, 2026 DST change).
 * `time_of_day` is judged on the clinic wall clock: morning is before 12:00 ET, afternoon 12:00 ET or later.
 *
 * `start_time` (#170, decisions r1/Q-1 and A-2): a clinic-local wall-clock floor, `HH:MM`, applied to every
 * day in the range, so a slot past the first `LIMITS.availabilityMaxSlots` of a day can be reached.
 * - It filters in `offerable`, like `time_of_day`, and combines with it as a strict AND. The repositories
 *   still read whole days, and the specialty walk counts only slots that pass, so it reads on to later days.
 * - Omitted → no floor; the search is exactly what it was before #170.
 * - Empty (`""`) or not `HH:MM` 24-hour → INVALID_INPUT from the contract's schema, before this handler runs.
 * - Any minute is accepted: "11:15" returns slots from 11:30. A time before opening is no floor in effect.
 * - At or after closing (`CLINIC.closeHour`) → INVALID_INPUT with the clinic hours, since no slot can match.
 * - Conflicting: 12:00 or later with `time_of_day: morning` → INVALID_INPUT with a hint, since no slot can
 *   match. A morning floor with `afternoon` is not a conflict: it returns afternoon slots.
 *   Both are errors rather than an empty success the model could misreport as "fully booked".
 * - Checks, in order: those two `start_time` errors come first, before the past-date check, the missing
 *   provider_id/specialty check, the unknown-provider check and the provider/specialty mismatch, so a
 *   request that can match on no day gets that error even when its other inputs are also wrong.
 * - Past: on today, a floor that has already passed changes nothing; the past-date rules below still apply.
 *
 * Past dates (decision): only slots that start strictly after `ctx.clock.now()` are ever offered.
 * - A range that is partly in the past is clamped to "from now"; the model isn't told, it just gets future slots.
 * - A range that ends before today (clinic-local) is INVALID_INPUT with a hint to ask for future dates,
 *   rather than an empty success the model could misreport as "fully booked".
 * - Today with every remaining slot already started is an ordinary empty success.
 *
 * Order: the repositories return slots ascending by start (AP-4) or by start, then providerId (AP-5), and
 * days are walked in order, so the candidates are already sorted and are only cut to the limit.
 */
import { CLINIC, LIMITS, type Provider, type ProviderId, type Slot, type ToolInput } from "@sched/contracts";

import {
  addDays,
  clinicDateOf,
  clinicDateRangeUtc,
  formatClinicDateTime,
  startsAfter,
  toZonedParts,
} from "../clock";
import { toolFail, toolOk, type ToolHandler } from "../handler";
import { toSlotOption } from "./summaries";

const NOON_MINUTES = 12 * 60;
const CLOSE_MINUTES = CLINIC.closeHour * 60;
const MAX = LIMITS.availabilityMaxSlots;

type TimeOfDay = ToolInput<"check_availability">["time_of_day"];

/** Minutes after clinic-local midnight at which a slot starts. */
function wallClockMinutes(startUtc: string): number {
  const { hour, minute } = toZonedParts(new Date(startUtc));
  return hour * 60 + minute;
}

/** `HH:MM` (already validated by the contract) as minutes after midnight. */
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function matchesTimeOfDay(minutes: number, timeOfDay: TimeOfDay): boolean {
  if (timeOfDay === "any") return true;
  return timeOfDay === "morning" ? minutes < NOON_MINUTES : minutes >= NOON_MINUTES;
}

/** A slot that can be offered, with the provider it will be described by. */
interface Candidate {
  slot: Slot;
  provider: Provider;
}

export const checkAvailability: ToolHandler<"check_availability"> = async (input, ctx) => {
  const {
    provider_id: providerId,
    specialty,
    date_range: range,
    time_of_day: timeOfDay,
    start_time: startTime,
  } = input;
  const floor = startTime === undefined ? 0 : minutesOf(startTime);
  if (floor >= CLOSE_MINUTES) {
    return toolFail(
      "INVALID_INPUT",
      "start_time is at or after closing time, so no slot can start then.",
      `Clinic hours are ${CLINIC.hours}. Ask the patient for an earlier time, or search the next day without start_time.`,
    );
  }
  if (timeOfDay === "morning" && floor >= NOON_MINUTES) {
    return toolFail(
      "INVALID_INPUT",
      "start_time is in the afternoon but time_of_day is morning, so no slot can match both.",
      "Call check_availability again with time_of_day afternoon or any, or with an earlier start_time.",
    );
  }
  const now = ctx.clock.now();
  const today = clinicDateOf(now);

  if (range.end_date < today) {
    return toolFail(
      "INVALID_INPUT",
      `The requested dates are in the past. It is now ${formatClinicDateTime(now)}.`,
      "Ask the patient which upcoming days they want, then call check_availability with dates from today onward.",
    );
  }
  const firstDay = range.start_date < today ? today : range.start_date;

  // Future, in the requested part of the day, at or after start_time, and by a provider in `providers`. A
  // slot whose provider record is missing can't be named to the patient, so it is left out rather than
  // failing the search.
  const offerable = (slots: readonly Slot[], providers: ReadonlyMap<ProviderId, Provider>): Candidate[] =>
    slots.flatMap((slot) => {
      const provider = providers.get(slot.providerId);
      if (!provider || !startsAfter(slot.startUtc, now)) return [];
      const minutes = wallClockMinutes(slot.startUtc);
      return minutes >= floor && matchesTimeOfDay(minutes, timeOfDay) ? [{ slot, provider }] : [];
    });

  let candidates: Candidate[];

  if (providerId !== undefined) {
    const provider = await ctx.repos.providers.get(providerId);
    if (!provider) {
      return toolFail(
        "NOT_FOUND",
        "No provider with that provider_id.",
        "Call find_providers (by name or specialty) to get a valid provider_id, then call check_availability again.",
      );
    }
    if (specialty !== undefined && provider.specialty !== specialty) {
      return toolFail(
        "INVALID_INPUT",
        "That provider does not practice the requested specialty.",
        "Call check_availability again with only provider_id, or only specialty. Use find_providers to check who practices what.",
      );
    }
    const utc = clinicDateRangeUtc(firstDay, range.end_date);
    const slots = await ctx.repos.slots.listOpenByProvider(providerId, utc);
    candidates = offerable(slots, new Map([[provider.providerId, provider]]));
  } else if (specialty !== undefined) {
    const list = await ctx.repos.providers.list({ specialty });
    const providers = new Map(list.filter((p) => p.acceptingNewPatients).map((p) => [p.providerId, p]));
    candidates = [];
    for (let day = firstDay; day <= range.end_date && candidates.length <= MAX; day = addDays(day, 1)) {
      candidates.push(
        ...offerable(await ctx.repos.slots.listOpenBySpecialtyAndDay(specialty, day), providers),
      );
    }
  } else {
    return toolFail(
      "INVALID_INPUT",
      "No provider_id or specialty was given; one of them is required.",
      "Ask the patient what kind of visit they need or which provider they want, then call check_availability again with specialty or provider_id.",
    );
  }

  return toolOk({
    slots: candidates.slice(0, MAX).map(({ slot, provider }) => toSlotOption(slot, provider)),
    truncated: candidates.length > MAX,
  });
};
