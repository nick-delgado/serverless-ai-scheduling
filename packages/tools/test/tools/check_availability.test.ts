import {
  LIMITS,
  makeSlotId,
  SPECIALTIES,
  toCanonicalUtc,
  TOOLS,
  type Provider,
  type Slot,
  type ToolError,
  type ToolOutput,
} from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS, type ClinicFixture } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import {
  createToolExecutor,
  TOOL_REGISTRY,
  type ToolContext,
  type ToolExecutionResult,
} from "../../src/registry";
import { createInMemoryRepositories, type InMemoryRepositories } from "../../src/repos/in-memory";
import { sequentialIds } from "../../src/repos/ids";
import { checkAvailability } from "../../src/tools/check_availability";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];

const outputOf = (r: ToolExecutionResult): ToolOutput<"check_availability"> => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return TOOLS.check_availability.output.parse(r.output);
};
const errorOf = (r: ToolExecutionResult): ToolError["error"] => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.output)}`);
  return r.error.error;
};
const localTimes = (r: ToolExecutionResult): string[] =>
  outputOf(r).slots.map((s) => s.start_local.replace(/^.* at /, ""));
const days = (start_date: string, end_date: string = start_date) => ({ start_date, end_date });
/** An extra OPEN 30-minute slot for a fixture provider, at any hour (the seed validator allows it). */
const openSlot = (provider: Provider, startUtc: string): Slot => ({
  slotId: makeSlotId(provider.providerId, startUtc),
  providerId: provider.providerId,
  specialty: provider.specialty,
  startUtc,
  endUtc: toCanonicalUtc(new Date(Date.parse(startUtc) + 30 * 60_000)),
  status: "OPEN",
});

describe("check_availability", () => {
  let fixture: ClinicFixture;
  let repos: InMemoryRepositories;
  let clock: FrozenClock;

  const contextFor = (patientId: string): ToolContext => ({
    patientId,
    conversationId: EXAMPLES.ConversationId,
    clock,
    repos,
  });
  const run = (input: unknown, patientId: string = MARIA): Promise<ToolExecutionResult> =>
    createToolExecutor({ check_availability: checkAvailability }, contextFor(patientId)).execute({
      id: "toolu_test",
      name: "check_availability",
      input,
    });

  beforeEach(() => {
    fixture = buildClinicFixture();
    clock = new FrozenClock(fixture.suggestedNow); // Mon Oct 5, 2026, 9:00 AM ET
    repos = createInMemoryRepositories({ seed: fixture, clock, ids: sequentialIds() });
  });

  it("is registered in TOOL_REGISTRY, so the model is offered it and calls reach this handler", async () => {
    const executor = createToolExecutor(TOOL_REGISTRY, contextFor(MARIA));
    expect(executor.definitions.map((d) => d.name)).toContain("check_availability");
    const result = await executor.execute({
      id: "toolu_test",
      name: "check_availability",
      input: { provider_id: "prov_lee", date_range: days("2026-10-06") },
    });
    expect(outputOf(result).slots[0]).toMatchObject({
      slot_id: "slot_lee_20261006T1200Z",
      start_local: "Tuesday, October 6, 2026 at 8:00 AM ET",
    });
  });

  describe("by provider (AP-4)", () => {
    it("returns open afternoon slots in time order, skipping the one Maria already holds", async () => {
      clock.set("2026-10-13T17:00:00Z"); // Tue Oct 13, 1:00 PM ET
      const result = await run({
        provider_id: "prov_lee",
        date_range: days("2026-10-13"),
        time_of_day: "afternoon",
      });
      expect(outputOf(result).slots[0]).toEqual({
        slot_id: "slot_lee_20261013T1730Z",
        provider_id: "prov_lee",
        provider_name: "Dr. Priya Lee",
        specialty: "dermatology",
        start_utc: "2026-10-13T17:30:00Z",
        start_local: "Tuesday, October 13, 2026 at 1:30 PM ET",
      });
      // 2:30 PM is Maria's (slot_lee_20261013T1830Z); 4:30 PM is past the limit.
      expect(localTimes(result)).toEqual([
        "1:30 PM ET",
        "2:00 PM ET",
        "3:00 PM ET",
        "3:30 PM ET",
        "4:00 PM ET",
      ]);
      expect(outputOf(result).truncated).toBe(true);
    });

    it("splits morning and afternoon at 12:00 PM ET", async () => {
      clock.set("2026-10-06T14:00:00Z"); // Tue Oct 6, 10:00 AM ET
      const morning = localTimes(
        await run({ provider_id: "prov_lee", date_range: days("2026-10-06"), time_of_day: "morning" }),
      );
      expect(morning).toEqual(["10:30 AM ET", "11:00 AM ET", "11:30 AM ET"]);
      const afternoon = localTimes(
        await run({ provider_id: "prov_lee", date_range: days("2026-10-06"), time_of_day: "afternoon" }),
      );
      expect(afternoon.at(0)).toBe("12:00 PM ET");
    });

    it("returns every slot id as a real, OPEN slot of that provider", async () => {
      const { slots } = outputOf(
        await run({ provider_id: "prov_okafor", date_range: days("2026-10-07", "2026-10-09") }),
      );
      expect(slots).toHaveLength(LIMITS.availabilityMaxSlots);
      for (const s of slots) {
        expect(await repos.slots.get(s.slot_id)).toMatchObject({ status: "OPEN", providerId: "prov_okafor" });
      }
    });

    it("answers an unknown provider_id with NOT_FOUND and a hint to call find_providers", async () => {
      const error = errorOf(await run({ provider_id: "prov_nobody", date_range: days("2026-10-06") }));
      expect(error.code).toBe("NOT_FOUND");
      expect(error.hint).toContain("find_providers");
    });

    it("rejects a provider_id that contradicts the specialty", async () => {
      const error = errorOf(
        await run({ provider_id: "prov_lee", specialty: "cardiology", date_range: days("2026-10-06") }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.hint).toBeDefined();
    });

    it("accepts a provider_id with its own specialty", async () => {
      expect(
        outputOf(
          await run({ provider_id: "prov_lee", specialty: "dermatology", date_range: days("2026-10-06") }),
        ).slots,
      ).toHaveLength(LIMITS.availabilityMaxSlots);
    });
  });

  describe("DST (ends Sun Nov 1, 2026)", () => {
    it("shows the same wall-clock times on both sides, with the right UTC instants", async () => {
      const before = outputOf(
        await run({ provider_id: "prov_kowalski", date_range: days("2026-10-30"), time_of_day: "morning" }),
      ).slots[0];
      const after = outputOf(
        await run({
          provider_id: "prov_kowalski",
          date_range: days("2026-10-31", "2026-11-02"),
          time_of_day: "morning",
        }),
      ).slots[0];
      expect(before).toMatchObject({
        start_utc: "2026-10-30T12:00:00Z", // EDT, UTC-4
        start_local: "Friday, October 30, 2026 at 8:00 AM ET",
      });
      expect(after).toMatchObject({
        start_utc: "2026-11-02T13:00:00Z", // EST, UTC-5
        start_local: "Monday, November 2, 2026 at 8:00 AM ET",
      });
    });

    it("judges an EST day's afternoon on the EST wall clock (specialty path)", async () => {
      const afternoon = outputOf(
        await run({
          specialty: "physical_therapy",
          date_range: days("2026-11-02"),
          time_of_day: "afternoon",
        }),
      );
      expect(afternoon.truncated).toBe(true); // 10 afternoon slots that day
      // 11:30 AM EST is 16:30Z, which a UTC-4 reading would call 12:30 PM.
      expect(afternoon.slots[0]).toMatchObject({
        start_utc: "2026-11-02T17:00:00Z",
        start_local: "Monday, November 2, 2026 at 12:00 PM ET",
      });
      expect(afternoon.slots.every((s) => s.start_local.startsWith("Monday, November 2"))).toBe(true);
    });

    it("bounds a provider_id search by clinic midnights, not UTC ones", async () => {
      const kowalski = fixture.providers.find((p) => p.providerId === "prov_kowalski");
      if (!kowalski) throw new Error("the fixture has no prov_kowalski");
      // Fri Nov 6 and Sat Nov 7 are EST (UTC-5); the fixture has nothing after 5:00 PM or on weekends.
      const eveningBefore = openSlot(kowalski, "2026-11-07T00:30:00Z"); // Fri Nov 6, 7:30 PM ET
      const lateOnTheDay = openSlot(kowalski, "2026-11-08T04:30:00Z"); // Sat Nov 7, 11:30 PM ET
      repos = createInMemoryRepositories({
        seed: { ...fixture, slots: [...fixture.slots, eveningBefore, lateOnTheDay] },
        clock,
        ids: sequentialIds(),
      });

      // Sat Nov 7 runs 05:00Z Nov 7 to 05:00Z Nov 8: the 04:30Z slot is in, the 00:30Z one is not.
      expect(outputOf(await run({ provider_id: "prov_kowalski", date_range: days("2026-11-07") }))).toEqual({
        slots: [
          {
            slot_id: lateOnTheDay.slotId,
            provider_id: "prov_kowalski",
            provider_name: "Dr. Anna Kowalski",
            specialty: "physical_therapy",
            start_utc: "2026-11-08T04:30:00Z",
            start_local: "Saturday, November 7, 2026 at 11:30 PM ET",
          },
        ],
        truncated: false,
      });
      // And the 00:30Z slot belongs to Friday.
      clock.set("2026-11-06T22:00:00Z"); // Fri Nov 6, 5:00 PM ET: the regular slots have all started
      expect(
        outputOf(await run({ provider_id: "prov_kowalski", date_range: days("2026-11-06") })).slots.map(
          (s) => s.slot_id,
        ),
      ).toEqual([eveningBefore.slotId]);
    });
  });

  describe("by specialty, or clinic-wide (AP-5 sparse index)", () => {
    it("uses the specialty+day index and stops once it has enough", async () => {
      const byDay = vi.spyOn(repos.slots, "listOpenBySpecialtyAndDay");
      const byProvider = vi.spyOn(repos.slots, "listOpenByProvider");
      const result = outputOf(
        await run({ specialty: "dermatology", date_range: days("2026-10-06", "2026-10-30") }),
      );
      expect(byDay).toHaveBeenCalledTimes(1);
      expect(byDay).toHaveBeenCalledWith("dermatology", "2026-10-06");
      expect(byProvider).not.toHaveBeenCalled();
      expect(result.truncated).toBe(true);
      expect(result.slots).toHaveLength(LIMITS.availabilityMaxSlots);
      // Interleaved by time, then provider.
      expect(result.slots.slice(0, 4).map((s) => s.slot_id)).toEqual([
        "slot_lee_20261006T1200Z",
        "slot_okafor_20261006T1200Z",
        "slot_lee_20261006T1230Z",
        "slot_okafor_20261006T1230Z",
      ]);
    });

    it("walks days in order until it finds matches (weekend days are skipped naturally)", async () => {
      const byDay = vi.spyOn(repos.slots, "listOpenBySpecialtyAndDay");
      const result = outputOf(
        await run({
          specialty: "cardiology",
          date_range: days("2026-10-10", "2026-10-12"),
          time_of_day: "afternoon",
        }),
      );
      expect(byDay.mock.calls.map((c) => c[1])).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
      expect(result.slots[0]?.start_local).toBe("Monday, October 12, 2026 at 12:00 PM ET");
      expect(result.truncated).toBe(true); // 9 afternoon slots for one cardiologist
    });

    it("searches every specialty when neither provider nor specialty is given", async () => {
      const byDay = vi.spyOn(repos.slots, "listOpenBySpecialtyAndDay");
      const result = await run({ date_range: days("2026-10-06") });
      expect(byDay).toHaveBeenCalledTimes(SPECIALTIES.length);
      expect(new Set(byDay.mock.calls.map((c) => c[0]))).toEqual(new Set(SPECIALTIES));
      const { slots, truncated } = outputOf(result);
      expect(truncated).toBe(true);
      // All at 8:00 AM, so in provider order across specialties.
      expect(slots.map((s) => s.provider_id)).toEqual([
        "prov_alvarez",
        "prov_brooks",
        "prov_chen",
        "prov_haddad",
        "prov_kowalski",
      ]);
      expect(new Set(localTimes(result))).toEqual(new Set(["8:00 AM ET"]));
    });

    it("leaves out a slot whose provider record is missing, and still answers", async () => {
      vi.spyOn(repos.providers, "list").mockResolvedValue(
        fixture.providers.filter((p) => p.providerId === "prov_okafor"), // no prov_lee
      );
      const { slots, truncated } = outputOf(
        await run({ specialty: "dermatology", date_range: days("2026-10-06") }),
      );
      expect(slots.map((s) => s.provider_id)).toEqual(Array(LIMITS.availabilityMaxSlots).fill("prov_okafor"));
      expect(slots[0]?.start_local).toBe("Tuesday, October 6, 2026 at 8:00 AM ET");
      expect(truncated).toBe(true);
    });

    it("answers an empty range (a weekend) with [] and truncated: false", async () => {
      expect(
        outputOf(await run({ specialty: "pediatrics", date_range: days("2026-10-10", "2026-10-11") })),
      ).toEqual({
        slots: [],
        truncated: false,
      });
    });

    it("sets truncated: false at exactly the limit", async () => {
      clock.set("2026-10-06T18:00:00Z"); // Tue Oct 6, 2:00 PM ET: 2:30 through 4:30 PM remain, exactly 5
      for (const input of [
        { provider_id: "prov_lee", date_range: days("2026-10-06") },
        { specialty: "cardiology", date_range: days("2026-10-06", "2026-10-06") },
      ]) {
        const result = outputOf(await run(input));
        expect(result.slots).toHaveLength(LIMITS.availabilityMaxSlots);
        expect(result.truncated).toBe(false);
      }
    });

    it("reads the next day when the first one fills exactly the limit, to know whether more exist", async () => {
      clock.set("2026-10-06T18:00:00Z"); // Tue Oct 6, 2:00 PM ET: exactly 5 cardiology slots left today
      const byDay = vi.spyOn(repos.slots, "listOpenBySpecialtyAndDay");
      const result = await run({ specialty: "cardiology", date_range: days("2026-10-06", "2026-10-07") });
      expect(byDay.mock.calls.map((c) => c[1])).toEqual(["2026-10-06", "2026-10-07"]);
      expect(localTimes(result)).toEqual([
        "2:30 PM ET",
        "3:00 PM ET",
        "3:30 PM ET",
        "4:00 PM ET",
        "4:30 PM ET",
      ]);
      expect(outputOf(result).truncated).toBe(true);
    });

    it("fills the limit across two days in time order", async () => {
      clock.set("2026-10-06T19:00:00Z"); // Tue Oct 6, 3:00 PM ET: three cardiology slots left today
      const { slots, truncated } = outputOf(
        await run({ specialty: "cardiology", date_range: days("2026-10-06", "2026-10-09") }),
      );
      expect(slots.map((s) => s.start_local)).toEqual([
        "Tuesday, October 6, 2026 at 3:30 PM ET",
        "Tuesday, October 6, 2026 at 4:00 PM ET",
        "Tuesday, October 6, 2026 at 4:30 PM ET",
        "Wednesday, October 7, 2026 at 8:00 AM ET",
        "Wednesday, October 7, 2026 at 8:30 AM ET",
      ]);
      expect(truncated).toBe(true);
    });
  });

  describe("the past, relative to ctx.clock", () => {
    it("never offers a slot that has already started today", async () => {
      // Now is 9:00 AM ET: the 8:00, 8:30 and 9:00 slots are gone.
      expect(localTimes(await run({ provider_id: "prov_lee", date_range: days("2026-10-05") })).at(0)).toBe(
        "9:30 AM ET",
      );
      expect(
        outputOf(await run({ specialty: "dermatology", date_range: days("2026-10-05") })).slots[0]?.start_utc,
      ).toBe("2026-10-05T13:30:00Z");
    });

    it("clamps a range that starts in the past to today", async () => {
      const byDay = vi.spyOn(repos.slots, "listOpenBySpecialtyAndDay");
      const result = outputOf(
        await run({ specialty: "cardiology", date_range: days("2026-10-01", "2026-10-05") }),
      );
      expect(byDay.mock.calls.map((c) => c[1])).toEqual(["2026-10-05"]);
      expect(result.slots[0]?.start_local).toBe("Monday, October 5, 2026 at 9:30 AM ET");
    });

    it("takes today from the clinic calendar, not the UTC one", async () => {
      clock.set("2026-10-06T01:00:00Z"); // Mon Oct 5, 9:00 PM ET, already Oct 6 in UTC
      const byDay = vi.spyOn(repos.slots, "listOpenBySpecialtyAndDay");
      // Oct 5 is still today: an empty success (every slot has started), not a past-dates error.
      expect(outputOf(await run({ specialty: "cardiology", date_range: days("2026-10-05") }))).toEqual({
        slots: [],
        truncated: false,
      });
      expect(byDay.mock.calls.map((c) => c[1])).toEqual(["2026-10-05"]);
    });

    it("rejects a range that ended before today, with a hint to ask for upcoming days", async () => {
      const error = errorOf(
        await run({ specialty: "cardiology", date_range: days("2026-10-01", "2026-10-02") }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain("Monday, October 5, 2026");
      expect(error.hint).toContain("upcoming");
    });

    it("follows the clock as it moves", async () => {
      clock.set("2026-10-13T20:45:00Z"); // Tue Oct 13, 4:45 PM ET: after the last slot starts
      expect(outputOf(await run({ provider_id: "prov_lee", date_range: days("2026-10-13") }))).toEqual({
        slots: [],
        truncated: false,
      });
    });
  });

  describe("input and identity", () => {
    it("rejects schema violations", async () => {
      expect(errorOf(await run({ date_range: days("2026-10-06", "2026-12-06") })).code).toBe("INVALID_INPUT");
      expect(errorOf(await run({ date_range: days("2026-10-06"), time_of_day: "evening" })).code).toBe(
        "INVALID_INPUT",
      );
      expect(
        errorOf(await run({ date_range: { start_date: "10/6/2026", end_date: "10/7/2026" } })).code,
      ).toBe("INVALID_INPUT");
    });

    it("rejects a model-supplied patient_id", async () => {
      expect(errorOf(await run({ patient_id: WALTER, date_range: days("2026-10-06") })).code).toBe(
        "INVALID_INPUT",
      );
    });

    it("answers the same for every patient and never reveals who holds a booked slot", async () => {
      const input = { provider_id: "prov_haddad", date_range: days("2026-10-15"), time_of_day: "morning" };
      const asMaria = outputOf(await run(input, MARIA));
      const asWalter = outputOf(await run(input, WALTER));
      expect(asWalter).toEqual(asMaria);
      // Walter's 10:00 AM with Dr. Haddad is simply absent, for him and for everyone else.
      expect(asMaria.slots.map((s) => s.start_local)).not.toContain(
        "Thursday, October 15, 2026 at 10:00 AM ET",
      );
      expect(JSON.stringify(asMaria)).not.toMatch(/appt_|patient/i);
    });

    it("writes nothing", async () => {
      const before = repos.snapshot();
      await run({ date_range: days("2026-10-06", "2026-10-09") });
      await run({ provider_id: "prov_lee", date_range: days("2026-10-13") });
      expect(repos.snapshot()).toEqual(before);
    });
  });
});
