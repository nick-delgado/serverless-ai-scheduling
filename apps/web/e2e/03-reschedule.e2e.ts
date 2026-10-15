/**
 * Reschedule (#40), on Chromium after every browser's booking (r1/Q-1 (a), r1/A-4): moves Sofia's one seeded BOOKED
 * appointment, with Dr. Elena Alvarez (`lib/plan.ts`), to another of her slots. The script and its checks are the
 * booking's (`02-book.e2e.ts`) with "Yes, please reschedule it." and `reschedule_appointment`; the end state is the
 * same appointment ID, still BOOKED with the same provider, on a new slot, and nothing added (r1/A-2).
 */
import { clinicDateOf } from "@sched/contracts";
import { test } from "@playwright/test";

import { rescheduleProblems, weekdaysAhead } from "./lib/end-state";
import { reschedulePlan } from "./lib/plan";
import { runWriteJourney } from "./support/journey";

/** The new day: five clinic weekdays ahead; the seeded visit is nine weekdays ahead. */
const MOVE_WEEKDAYS_AHEAD = 5;

test("reschedule: confirmed before it moves, then the same appointment on a new slot", async ({ page }) => {
  const plan = reschedulePlan();
  const day = weekdaysAhead(clinicDateOf(new Date()), MOVE_WEEKDAYS_AHEAD);
  await runWriteJourney(page, {
    label: `${plan.appointmentId} to ${day.date}`,
    script: {
      request: `I need to reschedule my appointment with ${plan.doctor} to ${day.label}.`,
      choose: "The earliest of those works for me.",
      confirm: "Yes, please reschedule it.",
    },
    tool: "reschedule_appointment",
    endState: (before, after) => rescheduleProblems(before, after, plan.appointmentId),
  });
});
