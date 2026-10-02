/**
 * The per-trial world: fault injection's edge cases (valid-input call counting, the fallback when the
 * slot can't be taken) and setup validation.
 */
import { describe, expect, it } from "vitest";

import { createTrialEnvironment, loadScenarios, type Scenario } from "../src";
import { productionInternalError } from "./helpers";

const { scenarios } = loadScenarios();
const scenario = (id: string): Scenario => {
  const s = scenarios.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return s;
};

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
