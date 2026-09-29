import type { Appointment, Slot } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { buildClinicFixture } from "../../fixtures";
import { providerMatchesName } from "../../src/repos/provider-match";
import { SeedValidationError, validateSeed, type ClinicSeed } from "../../src/repos/seed";

const base = buildClinicFixture({ weeks: 2 });
const MARIA_SLOT = "slot_lee_20261013T1830Z";
const MARIA_APPT = "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY";

function problemsOf(seed: ClinicSeed): readonly string[] {
  try {
    validateSeed(seed);
    return [];
  } catch (error) {
    if (error instanceof SeedValidationError) return error.problems;
    throw error;
  }
}

const withSlot = (slotId: string, change: (s: Slot) => Slot): ClinicSeed => ({
  ...base,
  slots: base.slots.map((s) => (s.slotId === slotId ? change(s) : s)),
});
const withAppointment = (appointmentId: string, change: (a: Appointment) => Appointment): ClinicSeed => ({
  ...base,
  appointments: base.appointments.map((a) => (a.appointmentId === appointmentId ? change(a) : a)),
});

describe("validateSeed", () => {
  it("accepts the fixture and returns fresh copies", () => {
    const parsed = validateSeed(base);
    expect(parsed).toEqual({
      patients: base.patients,
      providers: base.providers,
      slots: base.slots,
      appointments: base.appointments,
    });
    expect(parsed.slots[0]).not.toBe(base.slots[0]);
  });

  it.each<[string, ClinicSeed, RegExp]>([
    [
      "a schema-invalid entity",
      { ...base, patients: [{ ...base.patients[0], patientId: "nope" } as never] },
      /patients\[0\] is invalid/,
    ],
    [
      "a duplicate id",
      { ...base, providers: [...base.providers, ...base.providers.slice(0, 1)] },
      /duplicate providerId prov_alvarez/,
    ],
    [
      "a slot id that doesn't encode its key",
      withSlot(MARIA_SLOT, (s) => ({
        ...s,
        startUtc: "2026-10-13T19:00:00Z",
        endUtc: "2026-10-13T19:30:00Z",
      })),
      /does not encode/,
    ],
    [
      "a non-canonical slot time",
      withSlot("slot_lee_20261013T1800Z", (s) => ({ ...s, endUtc: "2026-10-13T18:30:00.000Z" })),
      /not canonical/,
    ],
    [
      "a slot in the wrong specialty",
      withSlot("slot_lee_20261013T1800Z", (s) => ({ ...s, specialty: "cardiology" })),
      /specialty cardiology != provider's dermatology/,
    ],
    [
      "a BOOKED appointment whose slot is OPEN",
      withSlot(MARIA_SLOT, ({ appointmentId: _a, ...s }) => ({ ...s, status: "OPEN" })),
      /BOOKED but slot .* is not held by it/,
    ],
    [
      "a slot held by a CANCELLED appointment",
      withAppointment(MARIA_APPT, (a) => ({ ...a, status: "CANCELLED" })),
      /held by .* which is CANCELLED/,
    ],
    [
      "an appointment for an unknown patient",
      withAppointment(MARIA_APPT, (a) => ({ ...a, patientId: "11111111-1111-4111-8111-111111111111" })),
      /unknown patient/,
    ],
    [
      "a BOOKED slot pointing at a missing appointment",
      withSlot("slot_lee_20261013T1800Z", (s) => ({
        ...s,
        status: "BOOKED",
        appointmentId: "appt_0000000042",
      })),
      /unknown appointment appt_0000000042/,
    ],
  ])("rejects %s", (_label, seed, problem) => {
    const problems = problemsOf(seed);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(problem);
  });
});

describe("providerMatchesName", () => {
  const lee = { firstName: "Priya", lastName: "Lee" };
  const jose = { firstName: "José", lastName: "Núñez-Ortiz" };

  it.each([
    ["Lee", true],
    ["lee", true],
    ["Dr. Lee", true],
    ["doctor priya", true],
    ["Priya Lee", true],
    ["Pri", true],
    ["Dr.", true], // only an honorific: matches everyone
    ["Leeds", false],
    ["Priya Okafor", false],
  ])("%j → %s for Dr. Priya Lee", (query, expected) => {
    expect(providerMatchesName(lee, query)).toBe(expected);
  });

  it("ignores accents and punctuation", () => {
    expect(providerMatchesName(jose, "jose nunez")).toBe(true);
    expect(providerMatchesName(jose, "Ortiz")).toBe(true);
  });
});
