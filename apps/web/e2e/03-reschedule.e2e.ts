/**
 * Reschedule (#40), on Chromium after every browser's booking (r1/Q-1 (a), r1/A-4): moves Sofia's one seeded BOOKED
 * appointment, with Dr. Elena Alvarez, to another Dr. Alvarez slot. The script and its checks are the booking's
 * (`02-book.e2e.ts`) with "Yes, please reschedule it." and `reschedule_appointment`; the end state is the same
 * appointment ID, still BOOKED with Dr. Alvarez, on a new slot, and nothing added (r1/A-2).
 */
import { clinicDateOf } from "@sched/contracts";
import { expect, test } from "@playwright/test";

import { describeAppointments, rescheduleProblems, weekdaysAhead } from "./lib/end-state";
import { confirmationProblems } from "./lib/turns";
import { runWriteScript, signIn, observePage } from "./support/chat";
import { e2eEnv, patientLogin } from "./support/env";
import { openTable } from "./support/table";

/** The fixture's BOOKED appointment for Sofia with Dr. Alvarez (`packages/tools/fixtures/clinic-default.ts`). */
const SEEDED_APPOINTMENT = "appt_01JBXB1F7G8H9J0K1M2N3P4Q5R";
/** The new day: five clinic weekdays ahead; the seeded visit is nine weekdays ahead. */
const MOVE_WEEKDAYS_AHEAD = 5;

test("reschedule: confirmed before it moves, then the same appointment on a new slot", async ({ page }) => {
  const env = e2eEnv();
  const login = patientLogin(env);
  const table = await openTable(env);
  const day = weekdaysAhead(clinicDateOf(new Date()), MOVE_WEEKDAYS_AHEAD);

  const before = await table.appointments(login.sub);
  console.log(`prov_alvarez to ${day.date}; appointments before:\n${describeAppointments(before)}`);

  await observePage(page);
  await signIn(page, login, "Sofia");
  const turns = await runWriteScript(
    page,
    {
      request: `I need to reschedule my appointment with Dr. Elena Alvarez to ${day.label}.`,
      choose: "The earliest of those works for me.",
      confirm: "Yes, please reschedule it.",
    },
    "reschedule_appointment",
  );

  const after = await table.appointments(login.sub);
  console.log(`appointments after:\n${describeAppointments(after)}`);
  expect(confirmationProblems(turns, "reschedule_appointment")).toEqual([]);
  expect(rescheduleProblems(before, after, SEEDED_APPOINTMENT)).toEqual([]);
});
