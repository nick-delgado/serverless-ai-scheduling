import { LIMITS, TOOLS, type ToolError, type ToolOutput } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import { createToolExecutor, type ToolContext, type ToolExecutionResult } from "../../src/registry";
import { createInMemoryRepositories, type InMemoryRepositories } from "../../src/repos/in-memory";
import { sequentialIds } from "../../src/repos/ids";
import { bookAppointment } from "../../src/tools/book_appointment";

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

  // Through the executor, so the strict contracts schemas the model faces apply to input and output.
  const run = (patientId: string, input: unknown): Promise<ToolExecutionResult> => {
    const ctx: ToolContext = { patientId, conversationId: EXAMPLES.ConversationId, clock, repos };
    return createToolExecutor({ book_appointment: bookAppointment }, ctx).execute({
      id: "toolu_test",
      name: "book_appointment",
      input,
    });
  };
  const slotStatus = async (slotId: string) => (await repos.slots.get(slotId))?.status;
  const bookedFor = (patientId: string) =>
    repos.snapshot().appointments.filter((a) => a.patientId === patientId);

  beforeEach(() => {
    const fixture = buildClinicFixture();
    clock = new FrozenClock(fixture.suggestedNow);
    repos = createInMemoryRepositories({ seed: fixture, clock, ids: sequentialIds() });
  });

  it("books an open slot and returns the appointment in clinic-local time", async () => {
    const out = outputOf(await run(AISHA, { slot_id: OPEN_SLOT, reason: "Itchy rash on my arm" }));
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
    const out = outputOf(await run(AISHA, { slot_id: DST_SLOT, reason: "Follow-up" }));
    expect(out.appointment.start_utc).toBe("2026-11-02T14:00:00Z");
    expect(out.appointment.start_local).toBe("Monday, November 2, 2026 at 9:00 AM ET");
  });

  it("trims the reason (the contract schema does it before the handler runs)", async () => {
    const out = outputOf(await run(AISHA, { slot_id: OPEN_SLOT, reason: "   Skin check  \n" }));
    expect(out.appointment.reason).toBe("Skin check");
  });

  it("is idempotent: the same patient retrying gets the existing appointment, and nothing new is written", async () => {
    const first = outputOf(await run(AISHA, { slot_id: OPEN_SLOT, reason: "Skin check" }));
    const afterFirst = repos.snapshot();
    const retry = outputOf(await run(AISHA, { slot_id: OPEN_SLOT, reason: "Different words" }));
    expect(retry).toEqual({ appointment: first.appointment, already_booked: true });
    expect(retry.appointment.reason).toBe("Skin check"); // the original reason is kept
    expect(repos.snapshot()).toEqual(afterFirst);
  });

  it("returns already_booked for a fixture appointment the patient already holds", async () => {
    const out = outputOf(await run(MARIA, { slot_id: MARIAS_SLOT, reason: "Mole check" }));
    expect(out.already_booked).toBe(true);
    expect(out.appointment).toMatchObject({
      appointment_id: "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY",
      start_local: "Tuesday, October 13, 2026 at 2:30 PM ET",
    });
  });

  it("answers SLOT_UNAVAILABLE with an alternatives hint when someone else holds the slot, changing nothing", async () => {
    const before = repos.snapshot();
    const error = errorOf(await run(WALTER, { slot_id: MARIAS_SLOT, reason: "Skin check" }));
    expect(error.code).toBe("SLOT_UNAVAILABLE");
    expect(error.hint).toMatch(/check_availability/);
    // Never reveals who holds it.
    expect(`${error.message} ${error.hint}`).not.toMatch(/Maria|Santos|appt_|patient_id/i);
    expect(repos.snapshot()).toEqual(before);
  });

  it("answers NOT_FOUND with a hint for an unknown slot", async () => {
    const before = repos.snapshot();
    const error = errorOf(await run(AISHA, { slot_id: UNKNOWN_SLOT, reason: "Skin check" }));
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
    const error = errorOf(await run(AISHA, { slot_id: slotId, reason: "Skin check" }));
    expect(error.code).toBe("NOT_ALLOWED");
    expect(error.hint).toMatch(/check_availability/);
    expect(repos.snapshot()).toEqual(before);
  });

  it("judges 'past' by ctx.clock, not the real clock", async () => {
    clock.set("2026-10-06T14:00:01Z"); // one second after OPEN_SLOT started
    expect(errorOf(await run(AISHA, { slot_id: OPEN_SLOT, reason: "Skin check" })).code).toBe("NOT_ALLOWED");
    clock.set("2026-10-06T13:59:59Z");
    expect(outputOf(await run(AISHA, { slot_id: OPEN_SLOT, reason: "Skin check" })).already_booked).toBe(
      false,
    );
  });

  it.each([
    ["an empty reason", { slot_id: OPEN_SLOT, reason: "   " }],
    ["an over-long reason", { slot_id: OPEN_SLOT, reason: "x".repeat(LIMITS.reasonMaxChars + 1) }],
    ["a malformed slot_id", { slot_id: "tuesday at 10", reason: "Skin check" }],
    ["a missing reason", { slot_id: OPEN_SLOT }],
  ])("rejects %s with INVALID_INPUT", async (_label, input) => {
    const before = repos.snapshot();
    expect(errorOf(await run(AISHA, input)).code).toBe("INVALID_INPUT");
    expect(repos.snapshot()).toEqual(before);
  });

  it("rejects a model-supplied patient_id and books for nobody (cross-patient attempt)", async () => {
    const before = repos.snapshot();
    const error = errorOf(await run(WALTER, { slot_id: OPEN_SLOT, reason: "Skin check", patient_id: MARIA }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(repos.snapshot()).toEqual(before);
  });

  it("always books for the context patient", async () => {
    const out = outputOf(await run(WALTER, { slot_id: OPEN_SLOT, reason: "Skin check" }));
    const stored = await repos.appointments.get(WALTER, out.appointment.appointment_id);
    expect(stored?.patientId).toBe(WALTER);
    expect(await repos.appointments.get(MARIA, out.appointment.appointment_id)).toBeNull();
  });

  it("parallel bookings of one slot by different patients: exactly one succeeds", async () => {
    const patients = [AISHA, JAMES, WALTER, MARIA];
    const results = await Promise.all(
      patients.map((p) => run(p, { slot_id: OPEN_SLOT, reason: "Skin check" })),
    );

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
    const results = await Promise.all(
      [1, 2, 3].map(() => run(AISHA, { slot_id: OPEN_SLOT, reason: "Skin check" })),
    );
    const outputs = results.map(outputOf);
    expect(outputs.filter((o) => !o.already_booked)).toHaveLength(1);
    expect(new Set(outputs.map((o) => o.appointment.appointment_id)).size).toBe(1);
    expect(bookedFor(AISHA)).toHaveLength(1);
  });
});
