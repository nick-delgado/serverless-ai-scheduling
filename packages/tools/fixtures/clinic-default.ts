/**
 * `clinic-default`: the seed dataset for unit tests, evals (ADR-008 `fixture: clinic-default`), and the dev
 * seed script (#14). Everyone here is fictional (CLAUDE.md rule 6).
 *
 * - 8 providers across the 5 specialties (PRD §5).
 * - 30-minute slots, Mon–Fri 8:00 AM–5:00 PM America/New_York, for `weeks` weeks starting at `baseDate`,
 *   converted to UTC with the offset in effect on each day (EDT −4 / EST −5; DST ends Sun Nov 1, 2026).
 * - 6 patients with fixed v4 UUIDs; some hold appointments, so those slots are BOOKED.
 *
 * Pure function of its options: no randomness and no reading of the current time.
 */
import {
  CLINIC,
  IsoDate,
  makeSlotId,
  toCanonicalUtc,
  type Appointment,
  type AppointmentStatus,
  type Patient,
  type PatientId,
  type Provider,
  type ProviderId,
  type Slot,
  type SlotId,
} from "@sched/contracts";

import { addDays, weekdayOf, zonedTimeToUtc } from "../src/clock";
import { validateSeed, type ClinicSeed } from "../src/repos/seed";

export const CLINIC_DEFAULT_NAME = "clinic-default";

/**
 * The defaults match the eval clock in ADR-008 and the contracts examples: Monday, October 5, 2026.
 * Five weeks (through Fri Nov 6) so the default window crosses the Nov 1 DST change, giving evals both
 * EDT and EST slots.
 */
export const CLINIC_DEFAULT_OPTIONS = { baseDate: "2026-10-05", weeks: 5 } as const;

export interface ClinicFixtureOptions {
  /** First day of the window (clinic-local). Any day of the week; weekends simply have no slots. */
  baseDate: string;
  /** Window length in weeks, 2..12. Slots cover `[baseDate, baseDate + 7 * weeks)`. */
  weeks: number;
}

export interface ClinicFixture extends ClinicSeed {
  name: typeof CLINIC_DEFAULT_NAME;
  baseDate: IsoDate;
  weeks: number;
  /** Days that have slots (Mon–Fri in the window), ascending. `clinicDays[0]` is "clinic day 0". */
  clinicDays: IsoDate[];
  /** A natural frozen "now" for this fixture: 9:00 AM clinic time on `baseDate` (ADR-008's eval clock). */
  suggestedNow: string;
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

export const FIXTURE_PROVIDERS: readonly Provider[] = [
  provider(
    "prov_alvarez",
    "Elena",
    "Alvarez",
    "MD",
    "family_medicine",
    true,
    "Family physician focused on preventive care.",
  ),
  provider(
    "prov_brooks",
    "Marcus",
    "Brooks",
    "DO",
    "family_medicine",
    false,
    "Family physician; currently not taking new patients.",
  ),
  provider(
    "prov_chen",
    "Hannah",
    "Chen",
    "MD",
    "pediatrics",
    true,
    "Pediatrician for newborns through teens.",
  ),
  provider(
    "prov_nakamura",
    "Kenji",
    "Nakamura",
    "MD",
    "pediatrics",
    true,
    "Pediatrician with an interest in asthma and allergies.",
  ),
  provider("prov_lee", "Priya", "Lee", "MD", "dermatology", true, "Board-certified dermatologist."),
  provider(
    "prov_okafor",
    "Samuel",
    "Okafor",
    "MD",
    "dermatology",
    true,
    "Dermatologist focused on skin checks and eczema.",
  ),
  provider(
    "prov_haddad",
    "Omar",
    "Haddad",
    "MD",
    "cardiology",
    true,
    "Cardiologist for blood pressure and heart rhythm care.",
  ),
  provider(
    "prov_kowalski",
    "Anna",
    "Kowalski",
    "DPT",
    "physical_therapy",
    true,
    "Physical therapist for sports and post-surgical rehab.",
  ),
];

/** Scenario handles (ADR-008 `patient: pat-maria`) → patientId (fixed v4 UUIDs; Maria's matches the contracts examples). */
export const FIXTURE_PATIENT_IDS = {
  "pat-maria": "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01",
  "pat-walter": "5a2d7c41-3e9b-4f06-8c1d-2b7e9f4a6c13",
  "pat-aisha": "8e4b2f90-6c1a-4d37-a5e2-9c0f3b7d1e24",
  "pat-daniel": "1c9e5a73-4b2f-4e8d-b6a1-7f3c0d9e2b35",
  "pat-sofia": "9b7f3d15-2a6c-4c59-8e0b-4d1a6f2c8e46",
  "pat-james": "6d1a8e27-9c4b-4a70-9f3e-5b2c7a0d4f57",
} as const satisfies Record<string, PatientId>;
export type FixturePatientAlias = keyof typeof FIXTURE_PATIENT_IDS;

const PATIENTS: readonly (Omit<Patient, "patientId" | "createdAt"> & { alias: FixturePatientAlias })[] = [
  {
    alias: "pat-maria",
    firstName: "Maria",
    lastName: "Santos",
    dateOfBirth: "1988-04-17",
    preferredProviderId: "prov_lee",
  },
  {
    alias: "pat-walter",
    firstName: "Walter",
    lastName: "Haines",
    dateOfBirth: "1955-02-11",
    preferredProviderId: "prov_haddad",
  },
  { alias: "pat-aisha", firstName: "Aisha", lastName: "Rahman", dateOfBirth: "1995-09-03" },
  {
    alias: "pat-daniel",
    firstName: "Daniel",
    lastName: "Park",
    dateOfBirth: "1979-12-22",
    preferredProviderId: "prov_kowalski",
  },
  {
    alias: "pat-sofia",
    firstName: "Sofia",
    lastName: "Marquez",
    dateOfBirth: "1990-06-30",
    preferredProviderId: "prov_alvarez",
  },
  { alias: "pat-james", firstName: "James", lastName: "Whitaker", dateOfBirth: "1983-03-09" },
];

/**
 * Existing appointments. `clinicDay` counts weekdays from `baseDate` (0 = first weekday on or after it;
 * negative = before it, outside the slot window). Times are clinic-local.
 */
const APPOINTMENTS: readonly {
  appointmentId: string;
  alias: FixturePatientAlias;
  providerId: ProviderId;
  clinicDay: number;
  time: [hour: number, minute: number];
  status: AppointmentStatus;
  reason: string;
}[] = [
  // Tuesday of week 2 at 2:30 PM: the contracts example (slot_lee_20261013T1830Z for the default base date).
  {
    appointmentId: "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY",
    alias: "pat-maria",
    providerId: "prov_lee",
    clinicDay: 6,
    time: [14, 30],
    status: "BOOKED",
    reason: "Mole check",
  },
  {
    appointmentId: "appt_01JBX8C4D5E6F7G8H9J0K1M2N3",
    alias: "pat-walter",
    providerId: "prov_haddad",
    clinicDay: 8,
    time: [10, 0],
    status: "BOOKED",
    reason: "Blood pressure follow-up",
  },
  {
    appointmentId: "appt_01J9Z2P3Q4R5S6T7V8W9X0Y1Z2",
    alias: "pat-walter",
    providerId: "prov_brooks",
    clinicDay: -15,
    time: [9, 0],
    status: "COMPLETED",
    reason: "Annual physical",
  },
  {
    appointmentId: "appt_01JBX9D5E6F7G8H9J0K1M2N3P4",
    alias: "pat-daniel",
    providerId: "prov_kowalski",
    clinicDay: 2,
    time: [16, 0],
    status: "BOOKED",
    reason: "Knee rehab session",
  },
  {
    appointmentId: "appt_01JBXA0E6F7G8H9J0K1M2N3P4Q",
    alias: "pat-daniel",
    providerId: "prov_okafor",
    clinicDay: 4,
    time: [9, 0],
    status: "CANCELLED",
    reason: "Rash on forearm",
  },
  {
    appointmentId: "appt_01JBXB1F7G8H9J0K1M2N3P4Q5R",
    alias: "pat-sofia",
    providerId: "prov_alvarez",
    clinicDay: 9,
    time: [11, 30],
    status: "BOOKED",
    reason: "Persistent cough",
  },
];

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

const MINUTE = 60_000;
const DAY = 86_400_000;
const isWeekday = (date: string): boolean => weekdayOf(date) >= 1 && weekdayOf(date) <= 5;

function provider(
  providerId: ProviderId,
  firstName: string,
  lastName: string,
  credentials: string,
  specialty: Provider["specialty"],
  acceptingNewPatients: boolean,
  bio: string,
): Provider {
  return {
    providerId,
    displayName: `Dr. ${firstName} ${lastName}`,
    firstName,
    lastName,
    credentials,
    specialty,
    acceptingNewPatients,
    bio: `${bio} (Fictional.)`,
  };
}

/** The `n`th weekday counting from `baseDate` (n ≥ 0: on or after it; n < 0: strictly before it). */
function nthWeekday(baseDate: string, n: number): IsoDate {
  let date = baseDate;
  const step = n >= 0 ? 1 : -1;
  let remaining = n >= 0 ? n : -n;
  if (n >= 0) {
    while (!isWeekday(date)) date = addDays(date, 1);
  } else {
    date = addDays(date, -1);
    while (!isWeekday(date)) date = addDays(date, -1);
    remaining -= 1;
  }
  while (remaining > 0) {
    date = addDays(date, step);
    if (isWeekday(date)) remaining -= 1;
  }
  return date;
}

/** Clinic-local wall time → canonical UTC string (`YYYY-MM-DDTHH:MM:00Z`). */
function clinicTime(date: string, hour: number, minute: number): string {
  return toCanonicalUtc(zonedTimeToUtc(date, { hour, minute }, CLINIC.timezone));
}

const plusMinutes = (iso: string, minutes: number): string =>
  toCanonicalUtc(new Date(Date.parse(iso) + minutes * MINUTE));
/** A fixed UTC timestamp `days` before `date`'s midnight UTC, at `hourUtc`:00. For createdAt-style fields. */
const daysBefore = (date: string, days: number, hourUtc: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY + hourUtc * 3_600_000).toISOString();

export function buildClinicFixture(options: Partial<ClinicFixtureOptions> = {}): ClinicFixture {
  const baseDate = IsoDate.parse(options.baseDate ?? CLINIC_DEFAULT_OPTIONS.baseDate);
  const weeks = options.weeks ?? CLINIC_DEFAULT_OPTIONS.weeks;
  if (!Number.isInteger(weeks) || weeks < 2 || weeks > 12) {
    throw new RangeError(`weeks must be an integer from 2 to 12, got ${weeks}`);
  }

  const clinicDays: IsoDate[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const date = addDays(baseDate, i);
    if (isWeekday(date)) clinicDays.push(date);
  }

  const patients: Patient[] = PATIENTS.map(({ alias, ...rest }) => ({
    patientId: FIXTURE_PATIENT_IDS[alias],
    ...rest,
    createdAt: daysBefore(baseDate, 180, 14),
  }));

  const slotsById = new Map<SlotId, Slot>();
  const visit = CLINIC.visitMinutes;
  for (const date of clinicDays) {
    for (const p of FIXTURE_PROVIDERS) {
      for (let m = CLINIC.openHour * 60; m + visit <= CLINIC.closeHour * 60; m += visit) {
        const startUtc = clinicTime(date, Math.floor(m / 60), m % 60);
        const slotId = makeSlotId(p.providerId, startUtc);
        slotsById.set(slotId, {
          slotId,
          providerId: p.providerId,
          specialty: p.specialty,
          startUtc,
          endUtc: plusMinutes(startUtc, visit),
          status: "OPEN",
        });
      }
    }
  }

  const specialtyOf = new Map(FIXTURE_PROVIDERS.map((p) => [p.providerId, p.specialty]));
  const appointments: Appointment[] = APPOINTMENTS.map((a) => {
    const date = nthWeekday(baseDate, a.clinicDay);
    const startUtc = clinicTime(date, a.time[0], a.time[1]);
    const endUtc = plusMinutes(startUtc, visit);
    const slotId = makeSlotId(a.providerId, startUtc);
    const specialty = specialtyOf.get(a.providerId);
    if (!specialty) throw new Error(`Fixture bug: unknown provider ${a.providerId}`);
    const createdAt = daysBefore(date, 14, 15);
    const updatedAt =
      a.status === "COMPLETED"
        ? new Date(Date.parse(endUtc)).toISOString()
        : a.status === "CANCELLED"
          ? daysBefore(baseDate, 2, 16)
          : createdAt;
    if (a.status === "BOOKED") {
      const slot = slotsById.get(slotId);
      if (!slot) throw new Error(`Fixture bug: ${a.appointmentId} is outside the slot window`);
      slotsById.set(slotId, { ...slot, status: "BOOKED", appointmentId: a.appointmentId });
    }
    return {
      appointmentId: a.appointmentId,
      patientId: FIXTURE_PATIENT_IDS[a.alias],
      providerId: a.providerId,
      slotId,
      specialty,
      startUtc,
      endUtc,
      status: a.status,
      reason: a.reason,
      createdAt,
      updatedAt,
    };
  });

  // validateSeed checks every entity against @sched/contracts and returns fresh copies in input order.
  const seed = validateSeed({
    patients,
    providers: FIXTURE_PROVIDERS,
    slots: [...slotsById.values()],
    appointments,
  });
  return {
    name: CLINIC_DEFAULT_NAME,
    baseDate,
    weeks,
    clinicDays,
    suggestedNow: zonedTimeToUtc(baseDate, { hour: 9, minute: 0 }).toISOString(),
    ...seed,
  };
}
