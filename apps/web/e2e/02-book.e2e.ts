/**
 * Login → book via text (#40), on every browser (NFR-006). Each browser books a different provider who takes new
 * patients and isn't Sofia's (`lib/plan.ts`), so no booking repeats an earlier one in the run (r1/Q-1 (a)).
 *
 * The script is fixed (r1/Q-2 (a)): a request naming the provider, the reason and the day, "The earliest of those
 * works for me.", then "Yes, please book it.", repeated while nothing is booked, six turns at most. It passes when
 * `book_appointment` runs exactly once, at or after the first "Yes" and never before, its chip shows while that turn
 * streams, and the table holds exactly one new BOOKED appointment with the provider (r1/A-2). The replies come from a
 * live model, so nothing reads their wording.
 */
import { clinicDateOf } from "@sched/contracts";
import { test } from "@playwright/test";

import { bookingProblems, weekdaysAhead } from "./lib/end-state";
import { bookingPlan } from "./lib/plan";
import { runWriteJourney } from "./support/journey";

/** The booking day: three clinic weekdays from the run's clinic-local date, inside the seeded window. */
const BOOK_WEEKDAYS_AHEAD = 3;

test("login → book via text: confirmed before it books, then one new appointment", async ({
  page,
}, testInfo) => {
  const booking = bookingPlan(testInfo.project.name);
  const day = weekdaysAhead(clinicDateOf(new Date()), BOOK_WEEKDAYS_AHEAD);
  await runWriteJourney(page, {
    label: `${testInfo.project.name}: ${booking.providerId} on ${day.date}`,
    script: {
      request: `I'd like to book ${booking.reason} with ${booking.doctor} on ${day.label}.`,
      choose: "The earliest of those works for me.",
      confirm: "Yes, please book it.",
    },
    tool: "book_appointment",
    endState: (before, after) => bookingProblems(before, after, booking.providerId),
  });
});
