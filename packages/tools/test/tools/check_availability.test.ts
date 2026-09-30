import { LIMITS, TOOLS, type ToolError, type ToolOutput } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import { createToolExecutor, type ToolContext, type ToolExecutionResult } from "../../src/registry";
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

describe("check_availability", () => {
  let repos: InMemoryRepositories;
  let clock: FrozenClock;

  const run = (input: unknown, patientId: string = MARIA): Promise<ToolExecutionResult> => {
    const ctx: ToolContext = { patientId, conversationId: EXAMPLES.ConversationId, clock, repos };
    return createToolExecutor({ check_availability: checkAvailability }, ctx).execute({
      id: "toolu_test",
      name: "check_availability",
      input,
    });
  };

  beforeEach(() => {
    const fixture = buildClinicFixture();
    clock = new FrozenClock(fixture.suggestedNow); // Mon Oct 5, 2026, 9:00 AM ET
    repos = createInMemoryRepositories({ seed: fixture, clock, ids: sequentialIds() });
  });

  describe("by provider (AP-4)", () => {
    it("returns open afternoon slots in time order, skipping the one Maria already holds", async () => {
      const result = outputOf(
        await run({ provider_id: "prov_lee", date_range: days("2026-10-13"), time_of_day: "afternoon" }),
      );
      expect(result.truncated).toBe(false);
      expect(result.slots[0]).toEqual({
        slot_id: "slot_lee_20261013T1600Z",
        provider_id: "prov_lee",
        provider_name: "Dr. Priya Lee",
        specialty: "dermatology",
        start_utc: "2026-10-13T16:00:00Z",
        start_local: "Tuesday, October 13, 2026 at 12:00 PM ET",
      });
      expect(result.slots.map((s) => s.slot_id)).not.toContain("slot_lee_20261013T1830Z");
      expect(
        localTimes(
          await run({ provider_id: "prov_lee", date_range: days("2026-10-13"), time_of_day: "afternoon" }),
        ),
      ).toEqual([
        "12:00 PM ET",
        "12:30 PM ET",
        "1:00 PM ET",
        "1:30 PM ET",
        "2:00 PM ET",
        "3:00 PM ET",
        "3:30 PM ET",
        "4:00 PM ET",
        "4:30 PM ET",
      ]);
    });

    it("splits morning and afternoon at 12:00 PM ET", async () => {
      const morning = localTimes(
        await run({ provider_id: "prov_lee", date_range: days("2026-10-06"), time_of_day: "morning" }),
      );
      expect(morning).toHaveLength(8);
      expect(morning.at(0)).toBe("8:00 AM ET");
      expect(morning.at(-1)).toBe("11:30 AM ET");
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

    it("keeps an EST day's range to exactly that clinic day (no spill from UTC midnight)", async () => {
      const all = outputOf(await run({ specialty: "physical_therapy", date_range: days("2026-11-02") }));
      // 18 slots that day; the first 10 run 8:00 AM to 12:30 PM ET.
      expect(all.truncated).toBe(true);
      const afternoon = outputOf(
        await run({
          specialty: "physical_therapy",
          date_range: days("2026-11-02"),
          time_of_day: "afternoon",
        }),
      );
      expect(afternoon.truncated).toBe(false);
      expect(afternoon.slots.at(-1)).toMatchObject({
        start_utc: "2026-11-02T21:30:00Z",
        start_local: "Monday, November 2, 2026 at 4:30 PM ET",
      });
      expect(afternoon.slots.every((s) => s.start_local.startsWith("Monday, November 2"))).toBe(true);
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
      expect(result.truncated).toBe(false); // 9 afternoon slots for one cardiologist
    });

    it("searches every specialty when neither provider nor specialty is given", async () => {
      const { slots, truncated } = outputOf(await run({ date_range: days("2026-10-06") }));
      expect(truncated).toBe(true);
      expect(slots.map((s) => s.provider_id)).toEqual([
        "prov_alvarez",
        "prov_brooks",
        "prov_chen",
        "prov_haddad",
        "prov_kowalski",
        "prov_lee",
        "prov_nakamura",
        "prov_okafor",
        "prov_alvarez",
        "prov_brooks",
      ]);
      expect(localTimes(await run({ date_range: days("2026-10-06") })).slice(7, 9)).toEqual([
        "8:00 AM ET",
        "8:30 AM ET",
      ]);
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
      clock.set("2026-10-06T15:30:00Z"); // Tue Oct 6, 11:30 AM ET: 12:00 through 4:30 PM remain, exactly 10
      for (const input of [
        { provider_id: "prov_lee", date_range: days("2026-10-06") },
        { specialty: "cardiology", date_range: days("2026-10-06", "2026-10-06") },
      ]) {
        const result = outputOf(await run(input));
        expect(result.slots).toHaveLength(LIMITS.availabilityMaxSlots);
        expect(result.truncated).toBe(false);
      }
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
