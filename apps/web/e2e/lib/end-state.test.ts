// @vitest-environment node
import type { Appointment } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { bookingProblems, describeAppointments, rescheduleProblems, weekdaysAhead } from "./end-state";

const appt = (id: string, extra: Partial<Appointment> = {}): Appointment => ({
  appointmentId: id,
  patientId: "9b7f3d15-2a6c-4c59-8e0b-4d1a6f2c8e46",
  providerId: "prov_alvarez",
  slotId: "slot_alvarez_20261026T1530Z",
  specialty: "family_medicine",
  startUtc: "2026-10-26T15:30:00Z",
  endUtc: "2026-10-26T16:00:00Z",
  status: "BOOKED",
  reason: "Persistent cough",
  createdAt: "2026-10-13T12:00:00Z",
  updatedAt: "2026-10-13T12:00:00Z",
  ...extra,
});

const SEEDED = appt("appt_01JBXB1F7G8H9J0K1M2N3P4Q5R");
const LEE = appt("appt_01JC0000000000000000000001", {
  providerId: "prov_lee",
  slotId: "slot_lee_20261016T1300Z",
  specialty: "dermatology",
  startUtc: "2026-10-16T13:00:00Z",
  endUtc: "2026-10-16T13:30:00Z",
});

describe("describeAppointments", () => {
  it("prints ID, provider, slot, start and status by start time, without the reason", () => {
    const text = describeAppointments([SEEDED, LEE]);
    expect(text).toBe(
      "  appt_01JC0000000000000000000001 prov_lee slot_lee_20261016T1300Z 2026-10-16T13:00:00Z BOOKED\n" +
        "  appt_01JBXB1F7G8H9J0K1M2N3P4Q5R prov_alvarez slot_alvarez_20261026T1530Z 2026-10-26T15:30:00Z BOOKED",
    );
    expect(text).not.toContain("cough");
  });

  it("says none for no appointments", () => {
    expect(describeAppointments([])).toBe("  (none)");
  });
});

describe("bookingProblems", () => {
  it("passes one new BOOKED appointment with the provider", () => {
    expect(bookingProblems([SEEDED], [SEEDED, LEE], "prov_lee")).toEqual([]);
  });

  it("fails no new appointment", () => {
    expect(bookingProblems([SEEDED], [SEEDED], "prov_lee")).toEqual(["expected 1 new appointment, found 0"]);
  });

  it("fails two new appointments", () => {
    const second = appt("appt_01JC0000000000000000000002", { providerId: "prov_lee" });
    expect(bookingProblems([SEEDED], [SEEDED, LEE, second], "prov_lee")).toEqual([
      "expected 1 new appointment, found 2",
    ]);
  });

  it("fails a new appointment with another provider", () => {
    expect(bookingProblems([SEEDED], [SEEDED, LEE], "prov_okafor")).toEqual([
      "the new appointment is with prov_lee, not prov_okafor",
    ]);
  });

  it("fails a new appointment that isn't BOOKED", () => {
    expect(bookingProblems([], [{ ...LEE, status: "CANCELLED" }], "prov_lee")).toEqual([
      "the new appointment is CANCELLED, not BOOKED",
    ]);
  });
});

describe("rescheduleProblems", () => {
  const MOVED = { ...SEEDED, slotId: "slot_alvarez_20261020T1400Z", startUtc: "2026-10-20T14:00:00Z" };

  it("passes the same appointment, still BOOKED with the same provider, on another slot", () => {
    expect(rescheduleProblems([SEEDED], [MOVED], SEEDED.appointmentId)).toEqual([]);
  });

  it("fails an appointment still on its slot", () => {
    expect(rescheduleProblems([SEEDED], [SEEDED], SEEDED.appointmentId)).toEqual([
      `${SEEDED.appointmentId} is still on ${SEEDED.slotId}`,
    ]);
  });

  it("fails an appointment that isn't BOOKED any more", () => {
    expect(rescheduleProblems([SEEDED], [{ ...MOVED, status: "CANCELLED" }], SEEDED.appointmentId)).toEqual([
      `${SEEDED.appointmentId} is CANCELLED, not BOOKED`,
    ]);
  });

  it("fails a move to another provider", () => {
    expect(
      rescheduleProblems([SEEDED], [{ ...MOVED, providerId: "prov_brooks" }], SEEDED.appointmentId),
    ).toEqual([`${SEEDED.appointmentId} moved to prov_brooks`]);
  });

  it("fails an added appointment (a booking instead of a move)", () => {
    expect(rescheduleProblems([SEEDED], [MOVED, LEE], SEEDED.appointmentId)).toEqual([
      "1 appointment(s) were added",
    ]);
  });

  it("fails an appointment missing before or after", () => {
    expect(rescheduleProblems([], [MOVED], SEEDED.appointmentId)).toEqual([
      `${SEEDED.appointmentId} is missing before the reschedule`,
    ]);
    expect(rescheduleProblems([SEEDED], [], SEEDED.appointmentId)).toEqual([
      `${SEEDED.appointmentId} is missing after the reschedule`,
    ]);
  });
});

describe("weekdaysAhead", () => {
  it("counts weekdays only, skipping the weekend", () => {
    // 2026-10-15 is a Thursday.
    expect(weekdaysAhead("2026-10-15", 1)).toEqual({ date: "2026-10-16", label: "Friday, October 16" });
    expect(weekdaysAhead("2026-10-15", 2)).toEqual({ date: "2026-10-19", label: "Monday, October 19" });
  });

  it("starts counting from a weekend day", () => {
    // 2026-10-17 is a Saturday.
    expect(weekdaysAhead("2026-10-17", 1)).toEqual({ date: "2026-10-19", label: "Monday, October 19" });
  });

  it("returns today for zero weekdays", () => {
    expect(weekdaysAhead("2026-10-13", 0).date).toBe("2026-10-13");
  });
});
