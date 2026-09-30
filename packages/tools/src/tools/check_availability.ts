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
 * Past dates (decision): only slots that start strictly after `ctx.clock.now()` are ever offered.
 * - A range that is partly in the past is clamped to "from now"; the model isn't told, it just gets future slots.
 * - A range that ends before today (clinic-local) is INVALID_INPUT with a hint to ask for future dates,
 *   rather than an empty success the model could misreport as "fully booked".
 * - Today with every remaining slot already started is an ordinary empty success.
 *
 * Order: the repositories return slots ascending by start (AP-4) or by start, then providerId (AP-5), and
 * days are walked in order, so the candidates are already sorted and are only cut to the limit.
 */
import {
  LIMITS,
  type Provider,
  type ProviderId,
  type Slot,
  type SlotOption,
  type ToolInput,
} from "@sched/contracts";

import { addDays, clinicDateOf, clinicDateRangeUtc, formatClinicDateTime, toZonedParts } from "../clock";
import { toolFail, toolOk, type ToolHandler } from "../registry";

const NOON = 12;
const MAX = LIMITS.availabilityMaxSlots;

type TimeOfDay = ToolInput<"check_availability">["time_of_day"];

function matchesTimeOfDay(startUtc: string, timeOfDay: TimeOfDay): boolean {
  if (timeOfDay === "any") return true;
  const hour = toZonedParts(new Date(startUtc)).hour;
  return timeOfDay === "morning" ? hour < NOON : hour >= NOON;
}

/** A slot that can be offered, with the provider it will be described by. */
interface Candidate {
  slot: Slot;
  provider: Provider;
}

const toSlotOption = ({ slot, provider }: Candidate): SlotOption => ({
  slot_id: slot.slotId,
  provider_id: slot.providerId,
  provider_name: provider.displayName,
  specialty: slot.specialty,
  start_utc: slot.startUtc,
  start_local: formatClinicDateTime(slot.startUtc),
});

export const checkAvailability: ToolHandler<"check_availability"> = async (input, ctx) => {
  const { provider_id: providerId, specialty, date_range: range, time_of_day: timeOfDay } = input;
  const now = ctx.clock.now();
  const nowMs = now.getTime();
  const today = clinicDateOf(now);

  if (range.end_date < today) {
    return toolFail(
      "INVALID_INPUT",
      `The requested dates are in the past. It is now ${formatClinicDateTime(now)}.`,
      "Ask the patient which upcoming days they want, then call check_availability with dates from today onward.",
    );
  }
  const firstDay = range.start_date < today ? today : range.start_date;

  // Future, in the requested part of the day, and by a provider in `providers`. A slot whose provider
  // record is missing can't be named to the patient, so it is left out rather than failing the search.
  const offerable = (slots: readonly Slot[], providers: ReadonlyMap<ProviderId, Provider>): Candidate[] =>
    slots.flatMap((slot) => {
      const provider = providers.get(slot.providerId);
      return provider && Date.parse(slot.startUtc) > nowMs && matchesTimeOfDay(slot.startUtc, timeOfDay)
        ? [{ slot, provider }]
        : [];
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
      "Say which provider or which specialty to search: provider_id or specialty is required.",
      "Ask the patient what kind of visit they need or which provider they want, then call check_availability again with specialty or provider_id.",
    );
  }

  return toolOk({ slots: candidates.slice(0, MAX).map(toSlotOption), truncated: candidates.length > MAX });
};
