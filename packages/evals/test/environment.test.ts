/**
 * The per-trial world: fault injection's edge cases (valid-input call counting, the fallback when the
 * slot can't be taken) and setup validation.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTrialEnvironment, uuidSequence, type Scenario } from "../src";
import { MARIA_APPT, productionInternalError, scenario } from "./helpers";

// book-slot-taken-offers-alternatives: the 1st valid book_appointment hits slot_taken_by_other_patient.
const SLOT_TAKEN = "book-slot-taken-offers-alternatives";
const OPEN_SLOT = "slot_haddad_20261012T1200Z";
const WALTERS_SLOT = "slot_haddad_20261015T1400Z"; // already BOOKED in the fixture

describe("fault injection", () => {
  it("counts only calls with valid input", async () => {
    const env = await createTrialEnvironment(scenario(SLOT_TAKEN));
    const invalid = await env.executor.execute({
      id: "t1",
      name: "book_appointment",
      input: { slot_id: OPEN_SLOT },
    });
    expect(invalid).toMatchObject({ ok: false, error: { error: { code: "INVALID_INPUT" } } });
    expect(env.faultsFired).toEqual([]);
    const valid = await env.executor.execute({
      id: "t2",
      name: "book_appointment",
      input: { slot_id: OPEN_SLOT, reason: "palpitations" },
    });
    expect(valid).toMatchObject({ ok: false, error: { error: { code: "SLOT_UNAVAILABLE" } } });
    expect(env.faultsFired).toEqual([
      expect.objectContaining({ tool: "book_appointment", call: 1, takenSlotId: OPEN_SLOT }),
    ]);
  });

  it("falls back to the harness's own error text when the slot can't be taken", async () => {
    const env = await createTrialEnvironment(scenario(SLOT_TAKEN));
    const result = await env.executor.execute({
      id: "t1",
      name: "book_appointment",
      input: { slot_id: WALTERS_SLOT, reason: "palpitations" },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        error: {
          code: "SLOT_UNAVAILABLE",
          message: "That time is no longer available.",
          hint: "Apologize and offer other options from check_availability.",
        },
      },
    });
    expect(env.faultsFired).toEqual([{ tool: "book_appointment", call: 1, error: "SLOT_UNAVAILABLE" }]);
  });
});

describe("injected INTERNAL faults say what production says (2e22f79/SMELL-202 decision)", () => {
  it("the harness's INTERNAL text equals the executor's error for a handler that throws", async () => {
    const env = await createTrialEnvironment(scenario("escalate-repeated-failure")); // book_appointment: all INTERNAL
    const injected = await env.executor.execute({
      id: "t1",
      name: "book_appointment",
      input: { slot_id: OPEN_SLOT, reason: "lingering cold" },
    });
    expect(injected).toEqual({ ok: false, error: { error: await productionInternalError() } });
  });
});

describe("fault injection: later calls and reschedules (2e22f79/TEST-206)", () => {
  const withFaults = (faults: NonNullable<Scenario["setup"]>["faults"]): Scenario => {
    const base = scenario("book-derm-next-week-afternoon"); // Maria
    return { ...base, setup: { ...base.setup, faults } };
  };

  it("`call: 2` lets the first valid call through and fails the second", async () => {
    const env = await createTrialEnvironment(
      withFaults([{ tool: "book_appointment", call: 2, error: "INTERNAL" }]),
    );
    const book = (id: string, slot: string) =>
      env.executor.execute({ id, name: "book_appointment", input: { slot_id: slot, reason: "mole check" } });
    expect((await book("t1", "slot_okafor_20261015T1800Z")).ok).toBe(true);
    expect(await book("t2", "slot_okafor_20261015T1830Z")).toEqual({
      ok: false,
      error: { error: await productionInternalError() },
    });
    expect(env.faultsFired).toEqual([{ tool: "book_appointment", call: 2, error: "INTERNAL" }]);
  });

  it("slot_taken_by_other_patient on reschedule takes the new slot, and the real handler answers", async () => {
    const env = await createTrialEnvironment(
      withFaults([
        {
          tool: "reschedule_appointment",
          call: 1,
          error: "SLOT_UNAVAILABLE",
          effect: "slot_taken_by_other_patient",
        },
      ]),
    );
    const newSlot = "slot_okafor_20261015T1800Z";
    const result = await env.executor.execute({
      id: "t1",
      name: "reschedule_appointment",
      input: { appointment_id: MARIA_APPT, new_slot_id: newSlot },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        error: {
          code: "SLOT_UNAVAILABLE",
          message: expect.stringContaining("The original appointment is unchanged") as unknown,
        },
      },
    });
    expect(env.faultsFired).toEqual([
      expect.objectContaining({ tool: "reschedule_appointment", call: 1, takenSlotId: newSlot }),
    ]);
    const maria = env.repos.snapshot().appointments.find((a) => a.appointmentId === MARIA_APPT);
    expect(maria?.slotId).toBe("slot_lee_20261013T1830Z"); // unchanged
  });
});

describe("uuidSequence (2e22f79/TEST-209)", () => {
  it("makes deterministic v4-shaped UUIDs, one counter per trial prefix", () => {
    const next = uuidSequence(3);
    expect([next(), next()]).toEqual([
      "00000003-0000-4000-8000-000000000001",
      "00000003-0000-4000-8000-000000000002",
    ]);
    expect(z.uuid().safeParse(uuidSequence(12)()).success).toBe(true);
  });
});

describe("setup validation", () => {
  it("rejects setup.appointments on a slot that isn't OPEN", async () => {
    const base = scenario("safety-indirect-injection-stored-reason");
    const [first] = base.setup?.appointments ?? [];
    if (first === undefined) throw new Error("scenario has no setup.appointments");
    const bad: Scenario = {
      ...base,
      setup: { ...base.setup, appointments: [{ ...first, slot_id: WALTERS_SLOT }] },
    };
    await expect(createTrialEnvironment(bad)).rejects.toThrow(
      `setup.appointments: ${WALTERS_SLOT} is not an OPEN slot in the fixture`,
    );
  });
});
