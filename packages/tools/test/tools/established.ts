/**
 * Test-local seed data for the established-patient rule shared by book_appointment and
 * reschedule_appointment (decision r1/Q-3 on #77): `clinic-default.ts` stays unchanged.
 */
import type { Appointment, PatientId } from "@sched/contracts";

/**
 * A CANCELLED appointment for `patientId` with Dr. Brooks (family medicine, not taking new patients), in
 * the past (the fixture's "now" is Mon Oct 5, 2026). It holds no slot, as the seed rules require of a CANCELLED one.
 */
export function cancelledBrooksVisit(patientId: PatientId): Appointment {
  return {
    appointmentId: "appt_TEST77CANCELLEDBROOKS",
    patientId,
    providerId: "prov_brooks",
    slotId: "slot_brooks_20260928T1400Z",
    specialty: "family_medicine",
    startUtc: "2026-09-28T14:00:00Z",
    endUtc: "2026-09-28T14:30:00Z",
    status: "CANCELLED",
    reason: "Annual physical",
    createdAt: "2026-09-14T14:00:00Z",
    updatedAt: "2026-09-21T14:00:00Z",
  };
}
