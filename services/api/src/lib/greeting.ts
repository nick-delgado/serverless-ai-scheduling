/**
 * The templated session greeting (FR-010): instant, no model call.
 *
 * - "Upcoming" is the get_my_appointments rule: the appointment starts at or after now. Only a BOOKED
 *   appointment is mentioned (a cancelled or completed one isn't something the patient is "booked" for).
 *   `listForPatient` returns start order (ties by appointment ID), so the first match is the next one.
 * - Times are the clinic's wall clock with the weekday, from `formatClinicDateTime` (the same `start_local`
 *   text the agent's tools show), e.g. "Tuesday, October 13, 2026 at 2:30 PM ET".
 * - A patient with no profile on file is greeted without a name. The profile, not the token, is the
 *   source of the name: the ID token carries no name claim (ADR-005).
 */
import type { Appointment, Provider, UpcomingAppointment } from "@sched/contracts";
import { formatClinicDateTime } from "@sched/tools";

/**
 * `SessionResponse.patient.firstName` when no profile is on file. The contract requires a non-empty name,
 * and the greeting itself says "Hi there!" instead of using it.
 */
export const NO_PROFILE_FIRST_NAME = "Patient";

/** The patient's next BOOKED appointment that starts at or after `now`, or null. */
export function nextUpcomingAppointment(appointments: readonly Appointment[], now: Date): Appointment | null {
  const nowMs = now.getTime();
  return appointments.find((a) => a.status === "BOOKED" && Date.parse(a.startUtc) >= nowMs) ?? null;
}

export function toUpcomingAppointment(appointment: Appointment, provider: Provider): UpcomingAppointment {
  return {
    appointmentId: appointment.appointmentId,
    providerName: provider.displayName,
    specialty: appointment.specialty,
    startUtc: appointment.startUtc,
    startLocal: formatClinicDateTime(appointment.startUtc),
  };
}

export function sessionGreeting(firstName: string | null, upcoming: UpcomingAppointment | null): string {
  const hello = firstName === null ? "Hi there!" : `Hi ${firstName}!`;
  const booked =
    upcoming === null ? "" : ` I see you're booked with ${upcoming.providerName} on ${upcoming.startLocal}.`;
  return `${hello}${booked} How can I help today?`;
}
