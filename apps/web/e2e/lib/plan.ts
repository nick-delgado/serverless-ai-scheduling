/**
 * Who the journeys book and move (#40, r1/Q-1 (a)), read from the clinic fixture the reseed writes: each browser books
 * a different provider who takes new patients and isn't Sofia's, and the reschedule moves Sofia's one seeded BOOKED
 * appointment. `planProblems` checks those preconditions offline, so a fixture change that breaks them fails a Vitest
 * test instead of a paid run. Pure.
 */
import type { Appointment, Provider } from "@sched/contracts";
import { buildClinicFixture, type ClinicFixture, FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";

/** The E2E patient (r1/Q-1 (a)); #44 picks its demo patients elsewhere. */
export const E2E_PATIENT = "pat-sofia" as const;

/** Each browser project's booking provider (r1/Q-1 (a)). */
export const BOOKING_PROVIDERS: Readonly<Record<string, string>> = {
  chromium: "prov_lee",
  webkit: "prov_okafor",
  firefox: "prov_haddad",
};

/** What the patient asks each specialty for; only the specialties the plan books. */
const REASONS: Readonly<Partial<Record<Provider["specialty"], string>>> = {
  dermatology: "a skin check",
  cardiology: "a blood pressure check",
};

export interface BookingPlan {
  providerId: string;
  /** "Dr. Priya Lee" */
  doctor: string;
  reason: string;
}

const patientId = FIXTURE_PATIENT_IDS[E2E_PATIENT];

/** The first name the greeting uses for `alias` (`fixture` defaults to the clinic fixture). */
export function fixtureFirstName(
  alias: keyof typeof FIXTURE_PATIENT_IDS,
  fixture: ClinicFixture = buildClinicFixture(),
): string {
  const patient = fixture.patients.find((p) => p.patientId === FIXTURE_PATIENT_IDS[alias]);
  if (!patient) throw new Error(`No fixture patient ${alias}`);
  return patient.firstName;
}

/** The booking for a browser project. Throws for a project the plan doesn't book with. */
export function bookingPlan(project: string, fixture: ClinicFixture = buildClinicFixture()): BookingPlan {
  const provider = fixture.providers.find((p) => p.providerId === BOOKING_PROVIDERS[project]);
  if (!provider) throw new Error(`No booking planned for project ${project}`);
  const reason = REASONS[provider.specialty];
  if (!reason) throw new Error(`No reason planned for ${provider.specialty}`);
  return { providerId: provider.providerId, doctor: provider.displayName, reason };
}

/** Sofia's seeded BOOKED appointments (the plan needs exactly one). */
const seededBooked = (fixture: ClinicFixture): Appointment[] =>
  fixture.appointments.filter((a) => a.patientId === patientId && a.status === "BOOKED");

/** The appointment the reschedule moves, and its doctor. */
export function reschedulePlan(fixture: ClinicFixture = buildClinicFixture()): {
  appointmentId: string;
  doctor: string;
} {
  const [appointment] = seededBooked(fixture);
  const provider = fixture.providers.find((p) => p.providerId === appointment?.providerId);
  if (!appointment || !provider) throw new Error(`No seeded BOOKED appointment for ${E2E_PATIENT}`);
  return { appointmentId: appointment.appointmentId, doctor: provider.displayName };
}

/** What in `fixture` breaks r1/Q-1 (a)'s plan; empty when it holds. */
export function planProblems(fixture: ClinicFixture = buildClinicFixture()): string[] {
  const problems: string[] = [];
  const sofia = fixture.patients.find((p) => p.patientId === patientId);
  if (!sofia) return [`no fixture patient ${E2E_PATIENT}`];
  for (const id of Object.values(BOOKING_PROVIDERS)) {
    const provider = fixture.providers.find((p) => p.providerId === id);
    if (!provider) problems.push(`${id} isn't in the fixture`);
    else if (!provider.acceptingNewPatients) problems.push(`${id} doesn't take new patients`);
    if (id === sofia.preferredProviderId) problems.push(`${id} is ${E2E_PATIENT}'s own provider`);
  }
  const booked = seededBooked(fixture);
  if (booked.length !== 1) {
    problems.push(`${E2E_PATIENT} has ${String(booked.length)} seeded BOOKED appointments, not 1`);
  }
  return problems;
}
