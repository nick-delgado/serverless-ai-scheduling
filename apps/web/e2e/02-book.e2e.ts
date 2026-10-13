/**
 * Login → book via text (#40), on every browser (NFR-006). Each browser books a different provider who takes new
 * patients and isn't Sofia's, so no booking repeats an earlier one in the run (r1/Q-1 (a)).
 *
 * The script is fixed (r1/Q-2 (a)): a request naming the provider, the reason and the day, "The earliest of those
 * works for me.", then "Yes, please book it.", repeated while nothing is booked, six turns at most. It passes when
 * `book_appointment` runs exactly once, at or after the first "Yes" and never before, its chip shows while that turn
 * streams, and the table holds exactly one new BOOKED appointment with the provider (r1/A-2). The replies come from a
 * live model, so nothing reads their wording.
 */
import { clinicDateOf } from "@sched/contracts";
import { expect, test } from "@playwright/test";

import { bookingProblems, describeAppointments, weekdaysAhead } from "./lib/end-state";
import { confirmationProblems } from "./lib/turns";
import { runWriteScript, signIn, observePage } from "./support/chat";
import { e2eEnv, patientLogin } from "./support/env";
import { openTable } from "./support/table";

const BOOKINGS: Record<string, { providerId: string; doctor: string; reason: string }> = {
  chromium: { providerId: "prov_lee", doctor: "Dr. Priya Lee", reason: "a skin check" },
  webkit: { providerId: "prov_okafor", doctor: "Dr. Samuel Okafor", reason: "an eczema check" },
  firefox: { providerId: "prov_haddad", doctor: "Dr. Omar Haddad", reason: "a blood pressure check" },
};

/** The booking day: three clinic weekdays from the run's clinic-local date, inside the seeded window. */
const BOOK_WEEKDAYS_AHEAD = 3;

test("login → book via text: confirmed before it books, then one new appointment", async ({
  page,
}, testInfo) => {
  const booking = BOOKINGS[testInfo.project.name];
  if (!booking) throw new Error(`No booking planned for project ${testInfo.project.name}`);
  const env = e2eEnv();
  const login = patientLogin(env);
  const table = await openTable(env);
  const day = weekdaysAhead(clinicDateOf(new Date()), BOOK_WEEKDAYS_AHEAD);

  const before = await table.appointments(login.sub);
  console.log(
    `${testInfo.project.name}: ${booking.providerId} on ${day.date}; appointments before:\n${describeAppointments(before)}`,
  );

  await observePage(page);
  await signIn(page, login, "Sofia");
  const turns = await runWriteScript(
    page,
    {
      request: `I'd like to book ${booking.reason} with ${booking.doctor} on ${day.label}.`,
      choose: "The earliest of those works for me.",
      confirm: "Yes, please book it.",
    },
    "book_appointment",
  );

  const after = await table.appointments(login.sub);
  console.log(`appointments after:\n${describeAppointments(after)}`);
  expect(confirmationProblems(turns, "book_appointment")).toEqual([]);
  expect(bookingProblems(before, after, booking.providerId)).toEqual([]);
});
