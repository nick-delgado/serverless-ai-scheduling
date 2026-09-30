/**
 * check_availability (FR-030): open slots by provider, by specialty, or across the clinic, within a
 * clinic-local date range, optionally mornings or afternoons only.
 *
 * Query paths (ADR-004):
 * - `provider_id` given → AP-4 `slots.listOpenByProvider` over the whole UTC range (one query).
 * - otherwise → AP-5, the sparse specialty+day index (`slots.listOpenBySpecialtyAndDay`), one clinic day
 *   at a time, for the requested specialty or for every specialty. Days are walked in order and the walk
 *   stops as soon as more than `LIMITS.availabilityMaxSlots` matches are in hand, so a typical request
 *   costs one or two days of queries, not 31.
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
 */
import {
  LIMITS,
  SPECIALTIES,
  type Provider,
  type ProviderId,
  type Slot,
  type SlotOption,
  type Specialty,
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

const toSlotOption = (slot: Slot, provider: Provider): SlotOption => ({
  slot_id: slot.slotId,
  provider_id: slot.providerId,
  provider_name: provider.displayName,
  specialty: slot.specialty,
  start_utc: slot.startUtc,
  start_local: formatClinicDateTime(slot.startUtc),
});

const byStartThenProvider = (a: Slot, b: Slot): number => {
  const d = Date.parse(a.startUtc) - Date.parse(b.startUtc);
  if (d !== 0) return d;
  return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
};

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

  let providers = new Map<ProviderId, Provider>();
  // Future, in the requested part of the day, and describable. A slot whose provider record is missing
  // can't be named to the patient, so it is left out rather than failing the whole search.
  const wanted = (slot: Slot): boolean =>
    Date.parse(slot.startUtc) > nowMs &&
    matchesTimeOfDay(slot.startUtc, timeOfDay) &&
    providers.has(slot.providerId);

  let matches: Slot[];

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
    providers = new Map([[provider.providerId, provider]]);
    const utc = clinicDateRangeUtc(firstDay, range.end_date);
    matches = (await ctx.repos.slots.listOpenByProvider(providerId, utc)).filter(wanted);
  } else {
    const list = await ctx.repos.providers.list(specialty !== undefined ? { specialty } : {});
    providers = new Map(list.map((p) => [p.providerId, p]));
    const specialties: readonly Specialty[] = specialty !== undefined ? [specialty] : SPECIALTIES;
    matches = [];
    for (let day = firstDay; day <= range.end_date && matches.length <= MAX; day = addDays(day, 1)) {
      const perSpecialty = await Promise.all(
        specialties.map((s) => ctx.repos.slots.listOpenBySpecialtyAndDay(s, day)),
      );
      matches.push(...perSpecialty.flat().filter(wanted).sort(byStartThenProvider));
    }
  }

  const options: SlotOption[] = matches
    .sort(byStartThenProvider)
    .slice(0, MAX)
    .flatMap((slot) => {
      const provider = providers.get(slot.providerId);
      return provider ? [toSlotOption(slot, provider)] : [];
    });

  return toolOk({ slots: options, truncated: matches.length > options.length });
};
