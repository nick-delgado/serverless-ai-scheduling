import { LIMITS, TOOLS, type ToolError, type ToolOutput } from "@sched/contracts";
import { confirmedFor, EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { bookAppointment } from "../../src/tools/book_appointment";
import { cancelledBrooksVisit } from "./established";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];
const AISHA = FIXTURE_PATIENT_IDS["pat-aisha"];
const JAMES = FIXTURE_PATIENT_IDS["pat-james"];

// Fixture clock: Mon Oct 5, 2026, 9:00 AM ET (13:00Z). All providers have 30-minute slots Mon–Fri 8–5 ET.
const OPEN_SLOT = "slot_lee_20261006T1400Z"; // Tue Oct 6, 10:00 AM EDT
const DST_SLOT = "slot_lee_20261102T1400Z"; // Mon Nov 2, 9:00 AM EST (after the Nov 1 change)
const PAST_SLOT = "slot_lee_20261005T1200Z"; // today 8:00 AM ET, one hour ago
const NOW_SLOT = "slot_lee_20261005T1300Z"; // starts exactly at "now"
const MARIAS_SLOT = "slot_lee_20261013T1830Z"; // Maria's BOOKED "Mole check"
const UNKNOWN_SLOT = "slot_lee_20261010T1400Z"; // well-formed, but a Saturday: no such slot
const MARIA_APPT = "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY"; // holds MARIAS_SLOT, Tue Oct 13, 2:30 PM EDT (18:30Z)
const BROOKS_SLOT = "slot_brooks_20261006T1400Z"; // Tue Oct 6, 10:00 AM EDT; Dr. Brooks isn't taking new patients
const BROOKS_LATER_SLOT = "slot_brooks_20261014T1300Z"; // Wed Oct 14, 9:00 AM EDT

/** A book_appointment input for `slotId` with the confirmed fields that match it, plus `extra` (#313). */
const inputFor = (slotId: string, extra: Record<string, unknown> = {}) => ({
  slot_id: slotId,
  ...confirmedFor(slotId),
  ...extra,
});

const outputOf = (r: ToolExecutionResult): ToolOutput<"book_appointment"> => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return TOOLS.book_appointment.output.parse(r.output);
};
const errorOf = (r: ToolExecutionResult): ToolError["error"] => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.output)}`);
  return r.error.error;
};

describe("book_appointment", () => {
  let repos: InMemoryRepositories;
  let clock: FrozenClock;

  const contextFor = (patientId: string): ToolContext => ({
    patientId,
    conversationId: EXAMPLES.ConversationId,
    clock,
    repos,
  });
  // Through the executor, so the strict contracts schemas the model faces apply to input and output.
  const run = (
    patientId: string,
    input: unknown,
    options: ToolExecutorOptions = {},
  ): Promise<ToolExecutionResult> =>
    createToolExecutor({ book_appointment: bookAppointment }, contextFor(patientId), options).execute({
      id: "toolu_test",
      name: "book_appointment",
      input,
    });
  /** A booking call that passes the confirmed fields matching `slotId` (tests not about the #313 check). */
  const book = (patientId: string, slotId: string, reason: string, options: ToolExecutorOptions = {}) =>
    run(patientId, inputFor(slotId, { reason }), options);
  const slotStatus = async (slotId: string) => (await repos.slots.get(slotId))?.status;
  const bookedFor = (patientId: string) =>
    repos.snapshot().appointments.filter((a) => a.patientId === patientId);

  beforeEach(() => {
    const fixture = buildClinicFixture();
    clock = new FrozenClock(fixture.suggestedNow);
    repos = createInMemoryRepositories({ seed: fixture, clock, ids: sequentialIds() });
  });

  it("is registered in TOOL_REGISTRY, so the model is offered it and calls reach this handler", async () => {
    const executor = createToolExecutor(TOOL_REGISTRY, contextFor(AISHA));
    expect(executor.definitions.map((d) => d.name)).toContain("book_appointment");
    const out = outputOf(
      await executor.execute({
        id: "toolu_test",
        name: "book_appointment",
        input: inputFor(OPEN_SLOT, { reason: "Skin check" }),
      }),
    );
    expect(out.already_booked).toBe(false);
    expect(out.appointment).toMatchObject({ provider_id: "prov_lee", start_utc: "2026-10-06T14:00:00Z" });
    expect(await slotStatus(OPEN_SLOT)).toBe("BOOKED");
  });

  it("books an open slot and returns the appointment in clinic-local time", async () => {
    const out = outputOf(await book(AISHA, OPEN_SLOT, "Itchy rash on my arm"));
    expect(out).toEqual({
      appointment: {
        appointment_id: "appt_0000000001",
        provider_id: "prov_lee",
        provider_name: "Dr. Priya Lee",
        specialty: "dermatology",
        start_utc: "2026-10-06T14:00:00Z",
        start_local: "Tuesday, October 6, 2026 at 10:00 AM ET",
        status: "BOOKED",
        reason: "Itchy rash on my arm",
      },
      already_booked: false,
    });
    expect(await slotStatus(OPEN_SLOT)).toBe("BOOKED");
    expect(bookedFor(AISHA)).toHaveLength(1);
  });

  it("shows the post-DST local time for a slot after Nov 1", async () => {
    const out = outputOf(await book(AISHA, DST_SLOT, "Follow-up"));
    expect(out.appointment.start_utc).toBe("2026-11-02T14:00:00Z");
    expect(out.appointment.start_local).toBe("Monday, November 2, 2026 at 9:00 AM ET");
  });

  it("trims the reason (the contract schema does it before the handler runs)", async () => {
    const out = outputOf(await book(AISHA, OPEN_SLOT, "   Skin check  \n"));
    expect(out.appointment.reason).toBe("Skin check");
  });

  it("is idempotent: the same patient retrying gets the existing appointment, and nothing new is written", async () => {
    const first = outputOf(await book(AISHA, OPEN_SLOT, "Skin check"));
    const afterFirst = repos.snapshot();
    const retry = outputOf(await book(AISHA, OPEN_SLOT, "Different words"));
    expect(retry).toEqual({ appointment: first.appointment, already_booked: true });
    expect(retry.appointment.reason).toBe("Skin check"); // the original reason is kept
    expect(repos.snapshot()).toEqual(afterFirst);
  });

  it("returns already_booked for a fixture appointment the patient already holds", async () => {
    const out = outputOf(await book(MARIA, MARIAS_SLOT, "Mole check"));
    expect(out.already_booked).toBe(true);
    expect(out.appointment).toMatchObject({
      appointment_id: "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY",
      start_local: "Tuesday, October 13, 2026 at 2:30 PM ET",
    });
  });

  it("answers SLOT_UNAVAILABLE with an alternatives hint when someone else holds the slot, changing nothing", async () => {
    const before = repos.snapshot();
    const error = errorOf(await book(WALTER, MARIAS_SLOT, "Skin check"));
    expect(error.code).toBe("SLOT_UNAVAILABLE");
    expect(error.hint).toMatch(/check_availability/);
    // Never reveals who holds it.
    expect(`${error.message} ${error.hint}`).not.toMatch(/Maria|Santos|appt_|patient_id/i);
    expect(repos.snapshot()).toEqual(before);
  });

  it("answers NOT_FOUND with a hint for an unknown slot", async () => {
    const before = repos.snapshot();
    const error = errorOf(await book(AISHA, UNKNOWN_SLOT, "Skin check"));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toMatch(/check_availability/);
    expect(repos.snapshot()).toEqual(before);
  });

  it.each([
    ["an hour ago", PAST_SLOT],
    ["exactly now", NOW_SLOT],
  ])("refuses a slot that started %s with NOT_ALLOWED, writing nothing", async (_label, slotId) => {
    expect(await slotStatus(slotId)).toBe("OPEN");
    const before = repos.snapshot();
    const error = errorOf(await book(AISHA, slotId, "Skin check"));
    expect(error.code).toBe("NOT_ALLOWED");
    expect(error.hint).toMatch(/check_availability/);
    expect(repos.snapshot()).toEqual(before);
  });

  it.each([
    ["at its start", "2026-10-13T18:30:00Z"],
    ["after its start", "2026-10-13T18:45:00Z"],
  ])(
    "returns the slot the patient already holds even %s (idempotency comes first), writing nothing",
    async (_label, now) => {
      clock.set(now);
      const before = repos.snapshot();
      const out = outputOf(await book(MARIA, MARIAS_SLOT, "Mole check"));
      expect(out.already_booked).toBe(true);
      expect(out.appointment.appointment_id).toBe(MARIA_APPT);
      expect(repos.snapshot()).toEqual(before);
      // Anyone else asking for that started slot still gets the past-slot rule, with no hint of who holds it.
      const error = errorOf(await book(WALTER, MARIAS_SLOT, "Check-up"));
      expect(error.code).toBe("NOT_ALLOWED");
      expect(JSON.stringify(error)).not.toMatch(/appt_|Maria|Mole/);
    },
  );

  it("judges 'past' by ctx.clock, not the real clock", async () => {
    clock.set("2026-10-06T14:00:01Z"); // one second after OPEN_SLOT started
    expect(errorOf(await book(AISHA, OPEN_SLOT, "Skin check")).code).toBe("NOT_ALLOWED");
    clock.set("2026-10-06T13:59:59Z");
    expect(outputOf(await book(AISHA, OPEN_SLOT, "Skin check")).already_booked).toBe(false);
  });

  it("refuses a new patient for a provider not taking new patients, writing nothing", async () => {
    const before = repos.snapshot();
    const error = errorOf(await book(JAMES, BROOKS_SLOT, "General check-up"));
    expect(error.code).toBe("NOT_ALLOWED");
    expect(error.hint).toMatch(/same specialty/);
    expect(repos.snapshot()).toEqual(before);
    expect(await slotStatus(BROOKS_SLOT)).toBe("OPEN");
  });

  it("refuses a patient whose appointments are only with other providers", async () => {
    // Maria holds a BOOKED appointment with Dr. Lee but has never seen Dr. Brooks.
    const before = repos.snapshot();
    const error = errorOf(await book(MARIA, BROOKS_SLOT, "General check-up"));
    expect(error.code).toBe("NOT_ALLOWED");
    expect(error.hint).toMatch(/same specialty/);
    expect(repos.snapshot()).toEqual(before);
  });

  it("books a patient whose only visit with a provider not taking new patients is BOOKED", async () => {
    // James has no history with Dr. Brooks. Book one future visit with him directly through the repo (the
    // tool rule doesn't apply to setup); that BOOKED visit alone makes him an existing patient.
    const setup = await repos.appointments.book({
      patientId: JAMES,
      slotId: BROOKS_LATER_SLOT,
      reason: "Check-up",
    });
    expect(setup.ok).toBe(true);
    const out = outputOf(await book(JAMES, BROOKS_SLOT, "Follow-up"));
    expect(out).toMatchObject({ already_booked: false, appointment: { provider_id: "prov_brooks" } });
    expect(await slotStatus(BROOKS_SLOT)).toBe("BOOKED");
  });

  it("refuses a patient whose only visit with a provider not taking new patients is CANCELLED", async () => {
    // A test-local seed (decision r1/Q-3): James's only Brooks appointment was cancelled, so he is still new.
    const fixture = buildClinicFixture();
    repos = createInMemoryRepositories({
      seed: { ...fixture, appointments: [...fixture.appointments, cancelledBrooksVisit(JAMES)] },
      clock,
      ids: sequentialIds(),
    });
    const before = repos.snapshot();
    const error = errorOf(await book(JAMES, BROOKS_SLOT, "General check-up"));
    expect(error.code).toBe("NOT_ALLOWED");
    expect(error.message).toMatch(/new patients/);
    expect(repos.snapshot()).toEqual(before);
  });

  it("books an existing patient with a provider not taking new patients", async () => {
    // Walter's fixture history has a COMPLETED annual physical with Dr. Brooks.
    const out = outputOf(await book(WALTER, BROOKS_SLOT, "Follow-up"));
    expect(out.already_booked).toBe(false);
    expect(out.appointment.provider_id).toBe("prov_brooks");
    expect(await slotStatus(BROOKS_SLOT)).toBe("BOOKED");
  });

  it("reports INTERNAL, writing nothing, when the slot's provider record is missing", async () => {
    vi.spyOn(repos.providers, "get").mockResolvedValue(null);
    const before = repos.snapshot();
    const causes: unknown[] = [];
    const result = await book(AISHA, OPEN_SLOT, "Skin check", {
      onInternalError: (error) => causes.push(error),
    });
    expect(errorOf(result).code).toBe("INTERNAL");
    // The handler's own guard, not a TypeError from reading a null provider.
    expect(String(causes[0])).toMatch(/Slot slot_lee_20261006T1400Z references unknown provider prov_lee/);
    expect(repos.snapshot()).toEqual(before);
  });

  it("answers NOT_FOUND with a hint when the slot disappears between the read and the booking", async () => {
    vi.spyOn(repos.appointments, "book").mockResolvedValue({ ok: false, reason: "SLOT_NOT_FOUND" });
    const error = errorOf(await book(AISHA, OPEN_SLOT, "Skin check"));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toMatch(/check_availability/);
  });

  it.each([
    ["an empty reason", inputFor(OPEN_SLOT, { reason: "   " })],
    ["an over-long reason", inputFor(OPEN_SLOT, { reason: "x".repeat(LIMITS.reasonMaxChars + 1) })],
    ["a malformed slot_id", { slot_id: "tuesday at 10", ...confirmedFor(OPEN_SLOT), reason: "Skin check" }],
    ["a missing reason", inputFor(OPEN_SLOT)],
  ])("rejects %s with INVALID_INPUT", async (_label, input) => {
    const before = repos.snapshot();
    expect(errorOf(await run(AISHA, input)).code).toBe("INVALID_INPUT");
    expect(repos.snapshot()).toEqual(before);
  });

  it("rejects a model-supplied patient_id and books for nobody (cross-patient attempt)", async () => {
    const before = repos.snapshot();
    const error = errorOf(
      await run(WALTER, inputFor(OPEN_SLOT, { reason: "Skin check", patient_id: MARIA })),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(repos.snapshot()).toEqual(before);
  });

  it("always books for the context patient", async () => {
    const out = outputOf(await book(WALTER, OPEN_SLOT, "Skin check"));
    const stored = await repos.appointments.get(WALTER, out.appointment.appointment_id);
    expect(stored?.patientId).toBe(WALTER);
    expect(await repos.appointments.get(MARIA, out.appointment.appointment_id)).toBeNull();
  });

  it("parallel bookings of one slot by different patients: exactly one succeeds", async () => {
    const patients = [AISHA, JAMES, WALTER, MARIA];
    const results = await Promise.all(patients.map((p) => book(p, OPEN_SLOT, "Skin check")));

    const [winner, ...otherWinners] = results.filter((r) => r.ok);
    expect(otherWinners).toHaveLength(0);
    expect(winner && outputOf(winner).already_booked).toBe(false);
    for (const loser of results.filter((r) => !r.ok)) expect(errorOf(loser).code).toBe("SLOT_UNAVAILABLE");

    const holders = repos.snapshot().appointments.filter((a) => a.slotId === OPEN_SLOT);
    expect(holders).toHaveLength(1);
    const slot = await repos.slots.get(OPEN_SLOT);
    expect(slot).toMatchObject({ status: "BOOKED", appointmentId: holders[0]?.appointmentId });
  });

  it("parallel duplicate calls by the same patient: one booking, the rest already_booked", async () => {
    const results = await Promise.all([1, 2, 3].map(() => book(AISHA, OPEN_SLOT, "Skin check")));
    const outputs = results.map(outputOf);
    expect(outputs.filter((o) => !o.already_booked)).toHaveLength(1);
    expect(new Set(outputs.map((o) => o.appointment.appointment_id)).size).toBe(1);
    expect(bookedFor(AISHA)).toHaveLength(1);
  });

  // #313: the slot must be the provider, date and time the patient said yes to (r1/Q-1 (c), A-4). Gate run
  // 38980920697: the agent restated 1:00 PM, the patient said yes, and the call carried the 12:00 PM slot.
  describe("confirmed slot (#313)", () => {
    const OKAFOR_NOON = "slot_okafor_20261013T1600Z"; // Tue Oct 13, 2026 12:00 PM EDT
    const OKAFOR_ONE_PM = "slot_okafor_20261013T1700Z"; // Tue Oct 13, 2026 1:00 PM EDT
    const LEE_ONE_PM = "slot_lee_20261013T1700Z"; // the same time with Dr. Lee
    const OKAFOR_ONE_THIRTY = "slot_okafor_20261013T1730Z"; // Tue Oct 13, 2026 1:30 PM EDT
    const CONFIRMED_ONE_PM = {
      confirmed_provider_id: "prov_okafor",
      confirmed_date: "2026-10-13",
      confirmed_time: "13:00",
    };

    /** Runs `input` for Maria and asserts CONFIRMATION_MISMATCH with nothing written; returns the error. */
    const expectMismatch = async (input: Record<string, unknown>): Promise<ToolError["error"]> => {
      const before = repos.snapshot();
      const error = errorOf(await run(MARIA, { reason: "Mole check", ...input }));
      expect(error.code).toBe("CONFIRMATION_MISMATCH");
      expect(repos.snapshot()).toEqual(before);
      return error;
    };

    it("refuses the 12:00 PM slot when the patient confirmed 1:00 PM, and writes nothing (gate run 38980920697)", async () => {
      const error = await expectMismatch({ slot_id: OKAFOR_NOON, ...CONFIRMED_ONE_PM });
      expect(error).toEqual({
        code: "CONFIRMATION_MISMATCH",
        message:
          "That slot is Tuesday, October 13, 2026 at 12:00 PM ET, and its provider or time isn't the one the patient confirmed. Nothing was booked.",
        hint: "Find the slot_id for the provider and time the patient confirmed in earlier check_availability results, or search again. Restate that time, get a new yes, then call again.",
      });
      expect(await slotStatus(OKAFOR_NOON)).toBe("OPEN");
      expect(bookedFor(MARIA)).toHaveLength(1); // only her fixture appointment
    });

    it("books the 1:00 PM slot when the patient confirmed 1:00 PM", async () => {
      const out = outputOf(
        await run(MARIA, { slot_id: OKAFOR_ONE_PM, ...CONFIRMED_ONE_PM, reason: "Mole check" }),
      );
      expect(out.appointment).toMatchObject({
        provider_id: "prov_okafor",
        start_local: "Tuesday, October 13, 2026 at 1:00 PM ET",
      });
      expect(await slotStatus(OKAFOR_ONE_PM)).toBe("BOOKED");
    });

    it("refuses a slot that differs only in the minutes: 1:30 PM against a confirmed 1:00 PM", async () => {
      await expectMismatch({ slot_id: OKAFOR_ONE_THIRTY, ...CONFIRMED_ONE_PM });
    });

    it("refuses the confirmed time on another day", async () => {
      await expectMismatch({ slot_id: OKAFOR_ONE_PM, ...CONFIRMED_ONE_PM, confirmed_date: "2026-10-14" });
    });

    it("refuses a slot at the confirmed date and time with another provider (r1/A-4)", async () => {
      await expectMismatch({ slot_id: LEE_ONE_PM, ...CONFIRMED_ONE_PM });
      expect(await slotStatus(LEE_ONE_PM)).toBe("OPEN");
    });

    it("compares clinic-local time after the DST change: 9:00 AM EST books, the EDT reading 10:00 is refused", async () => {
      const confirmed = { confirmed_provider_id: "prov_lee", confirmed_date: "2026-11-02" };
      await expectMismatch({ slot_id: DST_SLOT, ...confirmed, confirmed_time: "10:00" });
      const out = outputOf(
        await run(MARIA, { slot_id: DST_SLOT, ...confirmed, confirmed_time: "09:00", reason: "Mole check" }),
      );
      expect(out.appointment.start_utc).toBe("2026-11-02T14:00:00Z");
    });

    it("refuses a time not in HH:MM 24-hour form as INVALID_INPUT, before the handler runs", async () => {
      const before = repos.snapshot();
      const error = errorOf(
        await run(MARIA, {
          slot_id: OKAFOR_ONE_PM,
          ...CONFIRMED_ONE_PM,
          confirmed_time: "1:00 PM",
          reason: "Mole check",
        }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(repos.snapshot()).toEqual(before);
    });

    it("answers a retry of a slot the patient holds as already_booked, whatever it passes (r1/A-2)", async () => {
      const out = outputOf(
        await run(MARIA, { slot_id: MARIAS_SLOT, ...CONFIRMED_ONE_PM, reason: "Mole check" }),
      );
      expect(out.already_booked).toBe(true);
    });

    it("answers CONFIRMATION_MISMATCH before the past-slot rule (r1/A-2)", async () => {
      await expectMismatch({ slot_id: PAST_SLOT, ...CONFIRMED_ONE_PM });
    });
  });
});
