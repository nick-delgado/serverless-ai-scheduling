/**
 * The seed and handles the repository contract suite runs against: the clinic-default fixture trimmed to
 * the slots the tests touch (so a DynamoDB run writes ~80 slots per test, not ~2,900), plus ten extra
 * patients for the concurrency tests.
 */
import type { ConversationMessage, Patient, PatientId, SlotId } from "@sched/contracts";

import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "../../fixtures";
import { clinicDateOf } from "../../src/clock";
import type { ClinicSeed } from "../../src/repos/seed";

export const NOW = "2026-10-05T13:00:00.000Z"; // Monday 9:00 AM ET (ADR-008 eval clock)

export const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
export const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];
export const DANIEL = FIXTURE_PATIENT_IDS["pat-daniel"];
export const AISHA = FIXTURE_PATIENT_IDS["pat-aisha"];

/** Ten more patients with deterministic v4 UUIDs, for the parallel-booking tests. */
export const CROWD: PatientId[] = Array.from(
  { length: 10 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);

export const APPT = {
  mariaLee: "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY", // BOOKED, Tue Oct 13 2:30 PM ET with Dr. Lee
  walterHaddad: "appt_01JBX8C4D5E6F7G8H9J0K1M2N3", // BOOKED, Thu Oct 15 10:00 AM ET
  walterPast: "appt_01J9Z2P3Q4R5S6T7V8W9X0Y1Z2", // COMPLETED, Sep 14
  danielCancelled: "appt_01JBXA0E6F7G8H9J0K1M2N3P4Q", // CANCELLED; its slot (Okafor, Fri Oct 9 9:00 AM) is OPEN
} as const;

export const SLOT = {
  mariaHeld: "slot_lee_20261013T1830Z", // BOOKED by Maria
  walterHeld: "slot_haddad_20261015T1400Z", // BOOKED by Walter
  danielCancelled: "slot_okafor_20261009T1300Z", // OPEN (released by the cancelled appointment)
  leeTue2pm: "slot_lee_20261013T1800Z",
  leeTue3pm: "slot_lee_20261013T1900Z",
  leeTue330pm: "slot_lee_20261013T1930Z",
  okaforTue4pm: "slot_okafor_20261013T2000Z",
  leeWed10am: "slot_lee_20261014T1400Z",
  notSeeded: "slot_lee_20261020T1400Z", // well-formed id, not in the trimmed seed
} as const satisfies Record<string, SlotId>;

/** Dermatology on Tue Oct 13 and Wed Oct 14 (18 slots × 2 providers × 2 days), every BOOKED slot, and the cancelled one. */
export function contractSeed(): ClinicSeed {
  const full = buildClinicFixture({ baseDate: "2026-10-05", weeks: 2 });
  const derm = new Set(["2026-10-13", "2026-10-14"]);
  const extraPatients: Patient[] = CROWD.map((patientId, i) => ({
    patientId,
    firstName: "Test",
    lastName: `Patient${String.fromCharCode(65 + i)}`,
    dateOfBirth: "1990-01-01",
    createdAt: "2026-04-08T14:00:00.000Z",
  }));
  return {
    patients: [...full.patients, ...extraPatients],
    providers: full.providers,
    appointments: full.appointments,
    slots: full.slots.filter(
      (s) =>
        s.status === "BOOKED" ||
        s.slotId === SLOT.danielCancelled ||
        (s.specialty === "dermatology" && derm.has(clinicDateOf(s.startUtc))),
    ),
  };
}

export const CONV_A = "b1e2c3d4-5f60-4a7b-8c9d-0e1f2a3b4c5d";
export const CONV_B = "c7d8e9f0-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const TURN = "c2d3e4f5-6a7b-4c8d-9e0f-1a2b3c4d5e6f";

/** A valid message; content carries an extra SDK field to prove blocks round-trip untouched. */
export function message(conversationId: string, seq: number, text = `message ${seq}`): ConversationMessage {
  return {
    conversationId,
    seq,
    role: seq % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text, citations: null }],
    turnId: TURN,
    createdAt: new Date(Date.parse(NOW) + seq * 1000).toISOString(),
  };
}
