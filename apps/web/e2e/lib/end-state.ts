/**
 * The end-state checks of the booking and reschedule specs (#40, r1/A-2): the patient's appointments read from the
 * `e2e` table before and after the script, compared here. Pure, so the Vitest tests beside it can be seen failing
 * without AWS.
 */
import { addDays, type Appointment, type IsoDate, weekdayOf } from "@sched/contracts";

/** An appointment for the run log: its ID, provider, slot, start and status. No reason text. */
export function describeAppointment(a: Appointment): string {
  return `${a.appointmentId} ${a.providerId} ${a.slotId} ${a.startUtc} ${a.status}`;
}

/** The patient's appointments for the run log, one per line, ordered by start. */
export function describeAppointments(list: readonly Appointment[]): string {
  if (list.length === 0) return "  (none)";
  return [...list]
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc))
    .map((a) => `  ${describeAppointment(a)}`)
    .join("\n");
}

/**
 * What's wrong with a booking's end state; empty when `after` holds exactly one appointment `before` didn't, and it
 * is BOOKED with `providerId`.
 */
export function bookingProblems(
  before: readonly Appointment[],
  after: readonly Appointment[],
  providerId: string,
): string[] {
  const known = new Set(before.map((a) => a.appointmentId));
  const added = after.filter((a) => !known.has(a.appointmentId));
  if (added.length !== 1) return [`expected 1 new appointment, found ${String(added.length)}`];
  const [booked] = added as [Appointment];
  const problems: string[] = [];
  if (booked.status !== "BOOKED") problems.push(`the new appointment is ${booked.status}, not BOOKED`);
  if (booked.providerId !== providerId)
    problems.push(`the new appointment is with ${booked.providerId}, not ${providerId}`);
  return problems;
}

/**
 * What's wrong with a reschedule's end state; empty when `appointmentId` is still BOOKED with the same provider in
 * `after`, on a different slot than in `before`, and no appointment was added.
 */
export function rescheduleProblems(
  before: readonly Appointment[],
  after: readonly Appointment[],
  appointmentId: string,
): string[] {
  const was = before.find((a) => a.appointmentId === appointmentId);
  const now = after.find((a) => a.appointmentId === appointmentId);
  if (!was || !now) return [`${appointmentId} is missing ${was ? "after" : "before"} the reschedule`];
  const problems: string[] = [];
  if (now.status !== "BOOKED") problems.push(`${appointmentId} is ${now.status}, not BOOKED`);
  if (now.providerId !== was.providerId) problems.push(`${appointmentId} moved to ${now.providerId}`);
  if (now.slotId === was.slotId) problems.push(`${appointmentId} is still on ${was.slotId}`);
  const known = new Set(before.map((a) => a.appointmentId));
  const added = after.filter((a) => !known.has(a.appointmentId)).length;
  if (added > 0) problems.push(`${String(added)} appointment(s) were added`);
  return problems;
}

const LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * The clinic weekday `weekdays` weekdays after `today` (a clinic-local date), with the label the scripts say ("Friday,
 * October 16"). The seeded window starts on the run's clinic-local date (PR #117), so the specs pick days from it and
 * hard-code none.
 */
export function weekdaysAhead(today: IsoDate, weekdays: number): { date: IsoDate; label: string } {
  let date = today;
  for (let left = weekdays; left > 0;) {
    date = addDays(date, 1);
    const day = weekdayOf(date);
    if (day >= 1 && day <= 5) left -= 1;
  }
  return { date, label: LABEL.format(new Date(`${date}T12:00:00Z`)) };
}
