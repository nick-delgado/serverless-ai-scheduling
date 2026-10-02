import { TOOLS, type ToolError, type ToolOutput } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import {
  createToolExecutor,
  TOOL_REGISTRY,
  type ToolContext,
  type ToolExecutionResult,
  type ToolExecutorOptions,
} from "../../src/registry";
import { createInMemoryRepositories, type InMemoryRepositories } from "../../src/repos/in-memory";
import { sequentialIds } from "../../src/repos/ids";
import { TOOL_ERROR_CODE_FOR, type Repositories, type RescheduleErrorReason } from "../../src/repos/types";
import { rescheduleAppointment } from "../../src/tools/reschedule_appointment";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];
const DANIEL = FIXTURE_PATIENT_IDS["pat-daniel"];
const SOFIA = FIXTURE_PATIENT_IDS["pat-sofia"];

// Fixture facts (default base date Mon Oct 5, 2026; "now" is 9:00 AM ET that day).
const MARIA_APPT = "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY"; // Tue Oct 13, 2:30 PM EDT with Dr. Lee, "Mole check"
const MARIA_SLOT = "slot_lee_20261013T1830Z";
const WALTER_APPT = "appt_01JBX8C4D5E6F7G8H9J0K1M2N3"; // BOOKED, Thu Oct 15 with Dr. Haddad
const WALTER_SLOT = "slot_haddad_20261015T1400Z";
const WALTER_COMPLETED = "appt_01J9Z2P3Q4R5S6T7V8W9X0Y1Z2";
const DANIEL_CANCELLED = "appt_01JBXA0E6F7G8H9J0K1M2N3P4Q";
const SOFIA_APPT = "appt_01JBXB1F7G8H9J0K1M2N3P4Q5R"; // BOOKED, Fri Oct 16 with Dr. Alvarez (family medicine)
const UNKNOWN_APPT = "appt_01JZZZZZZZZZZZZZZZZZZZZZZZ";

const LEE_OCT_30_10AM_EDT = "slot_lee_20261030T1400Z"; // Friday before the Nov 1 DST change (UTC-4)
const LEE_NOV_2_10AM_EST = "slot_lee_20261102T1500Z"; // Monday after it (UTC-5)
const LEE_OCT_5_8AM = "slot_lee_20261005T1200Z"; // an hour before "now": OPEN but in the past
const OKAFOR_OCT_14_9AM = "slot_okafor_20261014T1300Z"; // another dermatologist
const BROOKS_OCT_14_9AM = "slot_brooks_20261014T1300Z"; // family medicine, not taking new patients
const ALVAREZ_OCT_14_10AM = "slot_alvarez_20261014T1400Z"; // family medicine, taking new patients
const HADDAD_OCT_14_9AM = "slot_haddad_20261014T1300Z"; // cardiology
const LEE_NOT_A_SLOT = "slot_lee_20261013T1845Z"; // well-formed id, no such slot (not on the 30-minute grid)

const outputOf = (r: ToolExecutionResult): ToolOutput<"reschedule_appointment"> => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return TOOLS.reschedule_appointment.output.parse(r.output);
};
const errorOf = (r: ToolExecutionResult): ToolError["error"] => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.output)}`);
  return r.error.error;
};

describe("reschedule_appointment", () => {
  let repos: InMemoryRepositories;
  let clock: FrozenClock;

  // Through the executor, so the strict input schema and output validation the model faces apply.
  const contextFor = (patientId: string, withRepos: Repositories = repos): ToolContext => ({
    patientId,
    conversationId: EXAMPLES.ConversationId,
    clock,
    repos: withRepos,
  });
  const run = (
    patientId: string,
    input: unknown,
    withRepos: Repositories = repos,
    options: ToolExecutorOptions = {},
  ): Promise<ToolExecutionResult> => {
    const ctx = contextFor(patientId, withRepos);
    return createToolExecutor({ reschedule_appointment: rescheduleAppointment }, ctx, options).execute({
      id: "toolu_test",
      name: "reschedule_appointment",
      input,
    });
  };
  const move = (patientId: string, appointmentId: string, newSlotId: string) =>
    run(patientId, { appointment_id: appointmentId, new_slot_id: newSlotId });

  /** Runs `attempt` and asserts it failed with `code` and a hint, leaving the whole store unchanged. */
  const expectFailureChangesNothing = async (
    attempt: () => Promise<ToolExecutionResult>,
    code: ToolError["error"]["code"],
  ): Promise<ToolError["error"]> => {
    const before = repos.snapshot();
    const error = errorOf(await attempt());
    expect(error.code).toBe(code);
    expect(error.hint).toBeTruthy();
    expect(repos.snapshot()).toEqual(before);
    return error;
  };

  const slotOf = (slotId: string) => repos.snapshot().slots.find((s) => s.slotId === slotId);

  /** Test setup: books `slotId` for `patientId` directly through the repo and returns the appointment id. */
  const bookFor = async (patientId: string, slotId: string, reason: string): Promise<string> => {
    const booked = await repos.appointments.book({ patientId, slotId, reason });
    if (!booked.ok) throw new Error(`setup failed: ${booked.reason}`);
    return booked.appointment.appointmentId;
  };

  beforeEach(() => {
    const fixture = buildClinicFixture();
    clock = new FrozenClock(fixture.suggestedNow);
    repos = createInMemoryRepositories({ seed: fixture, clock, ids: sequentialIds() });
  });

  it("moves the appointment across the Nov 1 DST change and quotes both times clinic-local", async () => {
    expect(outputOf(await move(MARIA, MARIA_APPT, LEE_NOV_2_10AM_EST))).toEqual({
      appointment: {
        appointment_id: MARIA_APPT,
        provider_id: "prov_lee",
        provider_name: "Dr. Priya Lee",
        specialty: "dermatology",
        start_utc: "2026-11-02T15:00:00Z",
        start_local: "Monday, November 2, 2026 at 10:00 AM ET",
        status: "BOOKED",
        reason: "Mole check",
      },
      previous_start_local: "Tuesday, October 13, 2026 at 2:30 PM ET",
      already_rescheduled: false,
    });

    // One transaction: old slot released, new slot held by the same appointment, still one appointment.
    expect(slotOf(MARIA_SLOT)).toMatchObject({ status: "OPEN" });
    expect(slotOf(MARIA_SLOT)?.appointmentId).toBeUndefined();
    expect(slotOf(LEE_NOV_2_10AM_EST)).toMatchObject({ status: "BOOKED", appointmentId: MARIA_APPT });
    const mine = await repos.appointments.listForPatient(MARIA);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ slotId: LEE_NOV_2_10AM_EST, updatedAt: clock.now().toISOString() });
  });

  it("uses the daylight-time offset on the other side of the DST change", async () => {
    const out = outputOf(await move(MARIA, MARIA_APPT, LEE_OCT_30_10AM_EDT));
    expect(out.appointment.start_utc).toBe("2026-10-30T14:00:00Z");
    expect(out.appointment.start_local).toBe("Friday, October 30, 2026 at 10:00 AM ET");
  });

  it("is registered in TOOL_REGISTRY, so the model is offered it and calls reach this handler", async () => {
    const executor = createToolExecutor(TOOL_REGISTRY, contextFor(MARIA));
    expect(executor.definitions.map((d) => d.name)).toContain("reschedule_appointment");
    const out = outputOf(
      await executor.execute({
        id: "toolu_test",
        name: "reschedule_appointment",
        input: { appointment_id: MARIA_APPT, new_slot_id: LEE_NOV_2_10AM_EST },
      }),
    );
    expect(out.appointment.start_utc).toBe("2026-11-02T15:00:00Z");
    expect(slotOf(LEE_NOV_2_10AM_EST)).toMatchObject({ status: "BOOKED", appointmentId: MARIA_APPT });
    expect(slotOf(MARIA_SLOT)).toMatchObject({ status: "OPEN" });
  });

  it("allows a move to another provider and names the new one", async () => {
    const out = outputOf(await move(MARIA, MARIA_APPT, OKAFOR_OCT_14_9AM));
    expect(out.appointment).toMatchObject({
      provider_id: "prov_okafor",
      provider_name: "Dr. Samuel Okafor",
      specialty: "dermatology",
      start_local: "Wednesday, October 14, 2026 at 9:00 AM ET",
    });
  });

  describe("provider and specialty rules", () => {
    it("NOT_ALLOWED for a slot in another specialty", async () => {
      const error = await expectFailureChangesNothing(
        () => move(MARIA, MARIA_APPT, HADDAD_OCT_14_9AM),
        "NOT_ALLOWED",
      );
      expect(error.hint).toMatch(/book_appointment/);
    });

    it("NOT_ALLOWED for a new patient of a provider who isn't taking new patients", async () => {
      // Sofia's family-medicine appointment is with Dr. Alvarez; she has no history with Dr. Brooks.
      expect(slotOf(BROOKS_OCT_14_9AM)).toMatchObject({ status: "OPEN" });
      const error = await expectFailureChangesNothing(
        () => move(SOFIA, SOFIA_APPT, BROOKS_OCT_14_9AM),
        "NOT_ALLOWED",
      );
      expect(error.message).toMatch(/new patients/);
      expect(error.hint).toMatch(/another provider in the same specialty/);
    });

    it("allows an existing patient to move to a provider who isn't taking new patients", async () => {
      // Walter has a COMPLETED visit with Dr. Brooks. Give him a family-medicine appointment to move.
      const walterFamily = await bookFor(WALTER, ALVAREZ_OCT_14_10AM, "Annual physical");
      const out = outputOf(await move(WALTER, walterFamily, BROOKS_OCT_14_9AM));
      expect(out.appointment).toMatchObject({
        provider_id: "prov_brooks",
        provider_name: "Dr. Marcus Brooks",
      });
      expect(slotOf(BROOKS_OCT_14_9AM)).toMatchObject({
        status: "BOOKED",
        appointmentId: walterFamily,
      });
    });
  });

  describe("cross-patient attempts", () => {
    it("treats another patient's appointment as not found and changes nothing", async () => {
      const error = await expectFailureChangesNothing(
        () => move(MARIA, WALTER_APPT, LEE_NOV_2_10AM_EST),
        "NOT_FOUND",
      );
      expect(error.message).not.toMatch(/another patient|someone else|belongs/i);
      // Both slots as they were: Walter keeps his time, the target stays open.
      expect(slotOf(WALTER_SLOT)).toMatchObject({ status: "BOOKED", appointmentId: WALTER_APPT });
      expect(slotOf(LEE_NOV_2_10AM_EST)).toMatchObject({ status: "OPEN" });
    });

    it("answers exactly like an unknown appointment id", async () => {
      const foreign = errorOf(await move(MARIA, WALTER_APPT, LEE_NOV_2_10AM_EST));
      const unknown = errorOf(await move(MARIA, UNKNOWN_APPT, LEE_NOV_2_10AM_EST));
      expect(foreign).toEqual(unknown);
    });

    it("rejects a model-supplied patient_id", async () => {
      await expectFailureChangesNothing(
        () =>
          run(MARIA, { appointment_id: WALTER_APPT, new_slot_id: LEE_NOV_2_10AM_EST, patient_id: WALTER }),
        "INVALID_INPUT",
      );
    });
  });

  it("rejects invalid input", async () => {
    await expectFailureChangesNothing(
      () => run(MARIA, { appointment_id: MARIA_APPT, new_slot_id: "tomorrow at 3" }),
      "INVALID_INPUT",
    );
  });

  describe("failures leave the store unchanged", () => {
    it("NOT_FOUND for an unknown appointment", async () => {
      await expectFailureChangesNothing(() => move(MARIA, UNKNOWN_APPT, LEE_NOV_2_10AM_EST), "NOT_FOUND");
    });

    it("NOT_FOUND for an unknown slot", async () => {
      const error = await expectFailureChangesNothing(
        () => move(MARIA, MARIA_APPT, LEE_NOT_A_SLOT),
        "NOT_FOUND",
      );
      expect(error.hint).toMatch(/check_availability/);
    });

    it("SLOT_UNAVAILABLE when the new slot is taken, keeping the original booking (all-or-nothing)", async () => {
      await bookFor(SOFIA, OKAFOR_OCT_14_9AM, "Skin check"); // the same specialty, held by someone else
      const error = await expectFailureChangesNothing(
        () => move(MARIA, MARIA_APPT, OKAFOR_OCT_14_9AM),
        "SLOT_UNAVAILABLE",
      );
      expect(error.hint).toMatch(/check_availability/);
      expect(slotOf(MARIA_SLOT)).toMatchObject({ status: "BOOKED", appointmentId: MARIA_APPT });
    });

    it("NOT_ALLOWED for a cancelled appointment", async () => {
      await expectFailureChangesNothing(
        () => move(DANIEL, DANIEL_CANCELLED, LEE_NOV_2_10AM_EST),
        "NOT_ALLOWED",
      );
    });

    it("NOT_ALLOWED for a completed appointment", async () => {
      await expectFailureChangesNothing(
        () => move(WALTER, WALTER_COMPLETED, LEE_NOV_2_10AM_EST),
        "NOT_ALLOWED",
      );
    });

    // The status check comes before the same-slot answer: a cancelled or completed appointment "retried"
    // into its own slot is still not movable, not already_rescheduled.
    it.each([
      ["cancelled", DANIEL, DANIEL_CANCELLED],
      ["completed", WALTER, WALTER_COMPLETED],
    ])(
      "NOT_ALLOWED for a %s appointment moved into the slot it held",
      async (_status, patientId, appointmentId) => {
        const appointment = await repos.appointments.get(patientId, appointmentId);
        if (!appointment) throw new Error(`fixture is missing ${appointmentId}`);
        await expectFailureChangesNothing(
          () => move(patientId, appointmentId, appointment.slotId),
          "NOT_ALLOWED",
        );
      },
    );

    it("NOT_ALLOWED for a new slot in the past, even though it is OPEN", async () => {
      expect(slotOf(LEE_OCT_5_8AM)).toMatchObject({ status: "OPEN" });
      const error = await expectFailureChangesNothing(
        () => move(MARIA, MARIA_APPT, LEE_OCT_5_8AM),
        "NOT_ALLOWED",
      );
      expect(error.message).toMatch(/past/);
      expect(error.hint).toMatch(/check_availability/);
    });

    it("NOT_ALLOWED for a new slot starting exactly now", async () => {
      clock.set("2026-10-05T12:00:00Z"); // LEE_OCT_5_8AM's start
      expect(slotOf(LEE_OCT_5_8AM)).toMatchObject({ status: "OPEN" });
      await expectFailureChangesNothing(() => move(MARIA, MARIA_APPT, LEE_OCT_5_8AM), "NOT_ALLOWED");
    });

    it("NOT_ALLOWED once the appointment itself has started (clock advanced)", async () => {
      clock.set("2026-10-13T18:30:00Z"); // Maria's start time
      const error = await expectFailureChangesNothing(
        () => move(MARIA, MARIA_APPT, LEE_NOV_2_10AM_EST),
        "NOT_ALLOWED",
      );
      expect(error.message).toMatch(/passed/);
    });

    it("answers already_rescheduled for the slot it already holds, changing nothing", async () => {
      const before = repos.snapshot();
      expect(outputOf(await move(MARIA, MARIA_APPT, MARIA_SLOT))).toEqual({
        appointment: {
          appointment_id: MARIA_APPT,
          provider_id: "prov_lee",
          provider_name: "Dr. Priya Lee",
          specialty: "dermatology",
          start_utc: "2026-10-13T18:30:00Z",
          start_local: "Tuesday, October 13, 2026 at 2:30 PM ET",
          status: "BOOKED",
          reason: "Mole check",
        },
        previous_start_local: null,
        already_rescheduled: true,
      });
      expect(repos.snapshot()).toEqual(before);
    });

    it("a retried call after success answers already_rescheduled and changes nothing more", async () => {
      expect(outputOf(await move(MARIA, MARIA_APPT, LEE_NOV_2_10AM_EST)).already_rescheduled).toBe(false);
      const before = repos.snapshot();
      const retry = outputOf(await move(MARIA, MARIA_APPT, LEE_NOV_2_10AM_EST));
      expect(retry).toMatchObject({ previous_start_local: null, already_rescheduled: true });
      expect(retry.appointment.start_local).toBe("Monday, November 2, 2026 at 10:00 AM ET");
      expect(repos.snapshot()).toEqual(before);
    });

    it("a retry after the new time has started still answers already_rescheduled", async () => {
      outputOf(await move(MARIA, MARIA_APPT, OKAFOR_OCT_14_9AM));
      clock.set("2026-10-14T13:05:00Z"); // five minutes into the new slot
      const before = repos.snapshot();
      const retry = outputOf(await move(MARIA, MARIA_APPT, OKAFOR_OCT_14_9AM));
      expect(retry).toMatchObject({ already_rescheduled: true, appointment: { provider_id: "prov_okafor" } });
      expect(repos.snapshot()).toEqual(before);
    });

    it("INTERNAL when the appointment already at the requested slot names a missing provider", async () => {
      const stubbed: Repositories = {
        ...repos,
        providers: { ...repos.providers, get: () => Promise.resolve(null) },
      };
      const before = repos.snapshot();
      const causes: unknown[] = [];
      const result = await run(MARIA, { appointment_id: MARIA_APPT, new_slot_id: MARIA_SLOT }, stubbed, {
        onInternalError: (error) => causes.push(error),
      });
      expect(errorOf(result).code).toBe("INTERNAL");
      // The handler's own guard, not a TypeError from reading a null provider.
      expect(String(causes[0])).toMatch(/references unknown provider prov_lee/);
      expect(repos.snapshot()).toEqual(before);
    });

    it("INTERNAL when the repository reports SAME_SLOT but the appointment can no longer be read", async () => {
      const realGet = repos.appointments.get;
      let reads = 0;
      const stubbed: Repositories = {
        ...repos,
        appointments: {
          ...repos.appointments,
          // The first read (before the write) finds it; the re-read after SAME_SLOT does not.
          get: (patientId, appointmentId) =>
            reads++ === 0 ? realGet(patientId, appointmentId) : Promise.resolve(null),
          reschedule: () => Promise.resolve({ ok: false, reason: "SAME_SLOT" }),
        },
      };
      const causes: unknown[] = [];
      const result = await run(
        MARIA,
        { appointment_id: MARIA_APPT, new_slot_id: LEE_NOV_2_10AM_EST },
        stubbed,
        { onInternalError: (error) => causes.push(error) },
      );
      expect(errorOf(result).code).toBe("INTERNAL");
      // The handler's own guard, not a TypeError from reading a null appointment.
      expect(String(causes[0])).toMatch(/vanished after SAME_SLOT/);
    });

    it("INTERNAL for a slot whose provider is missing, before anything is written", async () => {
      const stubbed: Repositories = {
        ...repos,
        providers: { ...repos.providers, get: () => Promise.resolve(null) },
      };
      const before = repos.snapshot();
      const result = await run(
        MARIA,
        { appointment_id: MARIA_APPT, new_slot_id: LEE_NOV_2_10AM_EST },
        stubbed,
      );
      expect(errorOf(result).code).toBe("INTERNAL");
      expect(repos.snapshot()).toEqual(before);
    });
  });

  it("parallel duplicate moves by the same patient: one move, the rest already_rescheduled", async () => {
    const results = (await Promise.all([1, 2, 3].map(() => move(MARIA, MARIA_APPT, LEE_NOV_2_10AM_EST)))).map(
      outputOf,
    );
    expect(results.filter((r) => !r.already_rescheduled)).toHaveLength(1);
    for (const r of results)
      expect(r.appointment.start_local).toBe("Monday, November 2, 2026 at 10:00 AM ET");
    expect(slotOf(LEE_NOV_2_10AM_EST)).toMatchObject({ status: "BOOKED", appointmentId: MARIA_APPT });
    expect(slotOf(MARIA_SLOT)).toMatchObject({ status: "OPEN" });
    expect(await repos.appointments.listForPatient(MARIA)).toHaveLength(1);
  });

  it("answers already_rescheduled when the repository reports SAME_SLOT (a concurrent retry moved it first)", async () => {
    const realReschedule = repos.appointments.reschedule;
    const stubbed: Repositories = {
      ...repos,
      appointments: {
        ...repos.appointments,
        reschedule: async (command) => {
          await realReschedule(command); // the other call's move lands first...
          return { ok: false, reason: "SAME_SLOT" }; // ...so this one finds the appointment already there
        },
      },
    };
    const out = outputOf(
      await run(MARIA, { appointment_id: MARIA_APPT, new_slot_id: LEE_NOV_2_10AM_EST }, stubbed),
    );
    expect(out).toMatchObject({ previous_start_local: null, already_rescheduled: true });
    expect(out.appointment.start_local).toBe("Monday, November 2, 2026 at 10:00 AM ET");
  });

  it("of two concurrent moves into one slot, exactly one wins and the loser keeps its original time", async () => {
    // Moves stay within a specialty, so give Walter a dermatology appointment to race Maria's with.
    const walterDerm = await bookFor(WALTER, OKAFOR_OCT_14_9AM, "Skin check");
    const [maria, walter] = await Promise.all([
      move(MARIA, MARIA_APPT, LEE_NOV_2_10AM_EST),
      move(WALTER, walterDerm, LEE_NOV_2_10AM_EST),
    ]);
    expect([maria.ok, walter.ok].filter(Boolean)).toHaveLength(1);
    const loser = maria.ok ? walter : maria;
    expect(errorOf(loser).code).toBe("SLOT_UNAVAILABLE");
    const snapshot = repos.snapshot();
    expect(snapshot.slots.filter((s) => s.appointmentId === MARIA_APPT)).toHaveLength(1);
    expect(snapshot.slots.filter((s) => s.appointmentId === walterDerm)).toHaveLength(1);
  });

  describe("maps every repository failure reason", () => {
    // Some reasons can't be reached through the fixture (CONFLICT is DynamoDB-only; the pre-checks catch
    // others first), so stub the repo's answer to prove each still maps to a code and a next step.
    const cases: [RescheduleErrorReason, ToolError["error"]["code"]][] = [
      ["APPOINTMENT_NOT_FOUND", "NOT_FOUND"],
      ["APPOINTMENT_NOT_BOOKED", "NOT_ALLOWED"],
      ["SLOT_NOT_FOUND", "NOT_FOUND"],
      ["SLOT_UNAVAILABLE", "SLOT_UNAVAILABLE"],
      ["CONFLICT", "INTERNAL"],
    ];
    it("has no error code for SAME_SLOT, which is answered as a success", () => {
      expect(Object.keys(TOOL_ERROR_CODE_FOR)).not.toContain("SAME_SLOT");
    });

    it.each(cases)("%s → %s with a hint", async (reason, code) => {
      const stubbed: Repositories = {
        ...repos,
        appointments: { ...repos.appointments, reschedule: () => Promise.resolve({ ok: false, reason }) },
      };
      const error = errorOf(
        await run(MARIA, { appointment_id: MARIA_APPT, new_slot_id: LEE_NOV_2_10AM_EST }, stubbed),
      );
      expect(error.code).toBe(code);
      expect(error.message).toMatch(/unchanged|Nothing was changed/);
      expect(error.hint).toBeTruthy();
    });
  });
});
