import { CLINIC, SPECIALTIES } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { describe, expect, it } from "vitest";

import { buildClinicFixture, CLINIC_DEFAULT_OPTIONS, FIXTURE_PATIENT_IDS, FIXTURES } from "../../fixtures";
import { clinicDateOf, toZonedParts } from "../../src/clock";
import { validateSeed } from "../../src/repos/seed";

const fixture = buildClinicFixture();
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("clinic-default fixture", () => {
  it("is registered under its scenario name", () => {
    expect(FIXTURES["clinic-default"]).toBe(buildClinicFixture);
    expect(fixture).toMatchObject({ name: "clinic-default", ...CLINIC_DEFAULT_OPTIONS });
  });

  it("is deterministic: same options, identical data", () => {
    expect(JSON.stringify(buildClinicFixture())).toBe(JSON.stringify(fixture));
    expect(buildClinicFixture(CLINIC_DEFAULT_OPTIONS)).toEqual(fixture);
  });

  it("passes seed validation (every entity valid per @sched/contracts, invariants hold)", () => {
    expect(() => validateSeed(fixture)).not.toThrow();
  });

  it("has 8 providers covering all 5 specialties, including Dr. Priya Lee and Dr. Samuel Okafor in dermatology", () => {
    expect(fixture.providers).toHaveLength(8);
    expect(new Set(fixture.providers.map((p) => p.specialty))).toEqual(new Set(SPECIALTIES));
    expect(fixture.providers.find((p) => p.providerId === "prov_lee")).toMatchObject({
      displayName: "Dr. Priya Lee",
      specialty: "dermatology",
    });
    expect(fixture.providers.find((p) => p.providerId === "prov_okafor")).toMatchObject({
      displayName: "Dr. Samuel Okafor",
      specialty: "dermatology",
    });
    expect(fixture.providers.every((p) => p.bio?.includes("Fictional"))).toBe(true);
  });

  it("has 6 patients with fixed v4 UUIDs; Maria matches the contracts examples", () => {
    expect(fixture.patients).toHaveLength(6);
    expect(fixture.patients.map((p) => p.patientId)).toEqual(Object.values(FIXTURE_PATIENT_IDS));
    expect(fixture.patients.every((p) => V4.test(p.patientId))).toBe(true);
    expect(fixture.patients.find((p) => p.patientId === EXAMPLES.Patient.patientId)).toMatchObject({
      firstName: EXAMPLES.Patient.firstName,
      lastName: EXAMPLES.Patient.lastName,
      dateOfBirth: EXAMPLES.Patient.dateOfBirth,
    });
  });

  it("has 4 weeks of weekday slots: 20 days × 8 providers × 18 half-hour slots", () => {
    expect(fixture.clinicDays).toHaveLength(20);
    expect(fixture.clinicDays[0]).toBe("2026-10-05");
    expect(fixture.clinicDays.at(-1)).toBe("2026-10-30");
    expect(fixture.slots).toHaveLength(20 * 8 * 18);
  });

  it("puts every slot inside clinic hours, Mon–Fri, 30 minutes long", () => {
    for (const slot of fixture.slots) {
      const local = toZonedParts(new Date(slot.startUtc), CLINIC.timezone);
      expect(local.weekday).toBeGreaterThanOrEqual(1);
      expect(local.weekday).toBeLessThanOrEqual(5);
      expect(local.hour * 60 + local.minute).toBeGreaterThanOrEqual(CLINIC.openHour * 60);
      expect(local.hour * 60 + local.minute + CLINIC.visitMinutes).toBeLessThanOrEqual(CLINIC.closeHour * 60);
      expect(Date.parse(slot.endUtc) - Date.parse(slot.startUtc)).toBe(CLINIC.visitMinutes * 60_000);
    }
  });

  it("books exactly the slots held by BOOKED appointments", () => {
    const booked = fixture.slots.filter((s) => s.status === "BOOKED");
    const bookedAppointments = fixture.appointments.filter((a) => a.status === "BOOKED");
    expect(booked.map((s) => s.appointmentId).sort()).toEqual(
      bookedAppointments.map((a) => a.appointmentId).sort(),
    );
    expect(bookedAppointments).toHaveLength(4);
    expect(fixture.appointments.map((a) => a.status).sort()).toEqual([
      "BOOKED",
      "BOOKED",
      "BOOKED",
      "BOOKED",
      "CANCELLED",
      "COMPLETED",
    ]);
  });

  it("gives Maria the appointment from the contracts examples (Dr. Lee, Tue Oct 13, 2:30 PM ET)", () => {
    const maria = fixture.appointments.filter((a) => a.patientId === FIXTURE_PATIENT_IDS["pat-maria"]);
    expect(maria).toHaveLength(1);
    expect(maria[0]).toMatchObject({
      appointmentId: EXAMPLES.Appointment.appointmentId,
      slotId: EXAMPLES.Appointment.slotId,
      startUtc: EXAMPLES.Appointment.startUtc,
      endUtc: EXAMPLES.Appointment.endUtc,
      reason: EXAMPLES.Appointment.reason,
    });
    // The reschedule example's target slot exists and is open.
    const target = fixture.slots.find((s) => s.slotId === EXAMPLES.RescheduleAppointmentInput.new_slot_id);
    expect(target?.status).toBe("OPEN");
  });

  it("uses 9:00 AM ET on the base date as the suggested frozen clock (ADR-008)", () => {
    expect(fixture.suggestedNow).toBe("2026-10-05T13:00:00.000Z");
  });

  it("has no randomness in timestamps: everything is derived from the base date", () => {
    const shifted = buildClinicFixture({ baseDate: "2026-10-12", weeks: 4 });
    const diff =
      Date.parse(shifted.patients[0]?.createdAt ?? "") - Date.parse(fixture.patients[0]?.createdAt ?? "");
    expect(diff).toBe(7 * 86_400_000);
  });

  describe("across the DST change (DST ends Sun Nov 1, 2026)", () => {
    const crossing = buildClinicFixture({ baseDate: "2026-10-26", weeks: 2 });
    const lee = (date: string) =>
      crossing.slots.filter((s) => s.providerId === "prov_lee" && clinicDateOf(s.startUtc) === date);

    it("keeps 8:00–16:30 ET on both sides, shifting the UTC times by an hour", () => {
      const friday = lee("2026-10-30");
      const monday = lee("2026-11-02");
      expect([friday[0]?.startUtc, friday.at(-1)?.startUtc]).toEqual([
        "2026-10-30T12:00:00Z",
        "2026-10-30T20:30:00Z",
      ]);
      expect([monday[0]?.startUtc, monday.at(-1)?.startUtc]).toEqual([
        "2026-11-02T13:00:00Z",
        "2026-11-02T21:30:00Z",
      ]);
      expect(friday).toHaveLength(18);
      expect(monday).toHaveLength(18);
    });

    it("has no weekend slots on the transition day", () => {
      expect(lee("2026-10-31")).toEqual([]);
      expect(lee("2026-11-01")).toEqual([]);
    });

    it("still validates, with a base date that isn't a Monday", () => {
      const midweek = buildClinicFixture({ baseDate: "2026-10-28", weeks: 2 });
      expect(midweek.clinicDays[0]).toBe("2026-10-28");
      expect(midweek.clinicDays).toHaveLength(10);
      expect(midweek.slots.filter((s) => s.status === "BOOKED")).toHaveLength(4);
    });
  });

  it("rejects unsupported options", () => {
    expect(() => buildClinicFixture({ weeks: 1 })).toThrow(RangeError);
    expect(() => buildClinicFixture({ weeks: 2.5 })).toThrow(RangeError);
    expect(() => buildClinicFixture({ baseDate: "2026-13-01" })).toThrow();
  });
});
