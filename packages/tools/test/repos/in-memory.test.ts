import { describe, expect, it } from "vitest";

import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "../../fixtures";
import { FrozenClock } from "../../src/clock";
import { sequentialIds } from "../../src/repos/ids";
import { createInMemoryRepositories } from "../../src/repos/in-memory";
import { SeedValidationError } from "../../src/repos/seed";
import { runRepositoryContract } from "../contract/repositories.contract";
import { CONV_A, message } from "../contract/scenario";

runRepositoryContract("in-memory", (seed, { clock, ids }) =>
  createInMemoryRepositories({ seed, clock, ids }),
);

describe("in-memory repositories: implementation specifics", () => {
  const clock = new FrozenClock("2026-10-05T13:00:00Z");
  const maria = FIXTURE_PATIENT_IDS["pat-maria"];

  it("loads the full clinic-default fixture", async () => {
    const fixture = buildClinicFixture();
    const repos = createInMemoryRepositories({ seed: fixture, clock });
    expect(await repos.providers.list()).toHaveLength(8);
    expect(await repos.slots.listOpenBySpecialtyAndDay("dermatology", "2026-10-13")).toHaveLength(35);
    expect(await repos.appointments.listForPatient(maria)).toHaveLength(1);
  });

  it("starts empty without a seed", async () => {
    const repos = createInMemoryRepositories({ clock });
    expect(await repos.providers.list()).toEqual([]);
    expect(repos.snapshot()).toEqual({
      patients: [],
      providers: [],
      slots: [],
      appointments: [],
      conversations: [],
      escalations: [],
    });
  });

  it("refuses an inconsistent seed", () => {
    const fixture = buildClinicFixture();
    const orphaned = {
      ...fixture,
      slots: fixture.slots.map((s) =>
        s.slotId === "slot_lee_20261013T1830Z"
          ? { ...s, appointmentId: undefined, status: "OPEN" as const }
          : s,
      ),
    };
    expect(() => createInMemoryRepositories({ seed: orphaned, clock })).toThrow(SeedValidationError);
  });

  it("snapshot() captures the whole store for eval end-state diffs, deterministically", async () => {
    const run = async () => {
      const repos = createInMemoryRepositories({ seed: buildClinicFixture(), clock, ids: sequentialIds() });
      await repos.appointments.book({
        patientId: maria,
        slotId: "slot_okafor_20261013T2000Z",
        reason: "Rash",
      });
      await repos.conversations.append(maria, [message(CONV_A, 0)]);
      await repos.escalations.record({
        patientId: maria,
        conversationId: CONV_A,
        reason: "patient_requested",
        summary: "Patient asked for a person.",
      });
      return repos.snapshot();
    };
    const [a, b] = [await run(), await run()];
    expect(a).toEqual(b);
    expect(a.appointments.map((x) => x.appointmentId)).toContain("appt_0000000001");
    expect(a.conversations).toEqual([
      { conversationId: CONV_A, patientId: maria, messages: [message(CONV_A, 0)] },
    ]);
    expect(a.escalations.map((e) => e.escalationId)).toEqual(["esc_0000000001"]);
  });

  it("does not mutate state before the caller's next await (behaves like real I/O)", async () => {
    const repos = createInMemoryRepositories({ seed: buildClinicFixture(), clock });
    const pending = repos.appointments.book({
      patientId: maria,
      slotId: "slot_okafor_20261013T2000Z",
      reason: "Rash",
    });
    expect(repos.snapshot().slots.find((s) => s.slotId === "slot_okafor_20261013T2000Z")?.status).toBe(
      "OPEN",
    );
    await pending;
    expect(repos.snapshot().slots.find((s) => s.slotId === "slot_okafor_20261013T2000Z")?.status).toBe(
      "BOOKED",
    );
  });
});
