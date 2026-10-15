/**
 * A scripted write journey (#40): the booking and reschedule specs' shared body. It prints the patient's appointments
 * before and after (r1/Q-1 edges), signs in fresh, runs the script (r1/Q-2 (a)), then checks the confirmation order
 * from the stream and the end state from the table (r1/A-2).
 */
import type { Appointment, ToolName } from "@sched/contracts";
import { expect, type Page } from "@playwright/test";

import { describeAppointments } from "../lib/end-state";
import { confirmationProblems, type WriteScript } from "../lib/turns";
import { observePage, runWriteScript, signIn } from "./chat";
import { e2eEnv, patientLogin } from "./env";
import { openTable } from "./table";

export interface WriteJourney {
  /** What the run log says the journey does, e.g. `chromium: prov_lee on 2026-10-16`. */
  label: string;
  script: WriteScript;
  tool: ToolName;
  /** What's wrong with the end state; empty when it holds. */
  endState: (before: readonly Appointment[], after: readonly Appointment[]) => string[];
}

export async function runWriteJourney(page: Page, journey: WriteJourney): Promise<void> {
  const env = e2eEnv();
  const login = patientLogin(env);
  const table = await openTable(env);

  const before = await table.appointments(login.sub);
  console.log(`${journey.label}; appointments before:\n${describeAppointments(before)}`);

  await observePage(page);
  await signIn(page, login);
  const turns = await runWriteScript(page, journey.script, journey.tool);

  const after = await table.appointments(login.sub);
  console.log(`appointments after:\n${describeAppointments(after)}`);
  expect(confirmationProblems(turns, journey.tool)).toEqual([]);
  expect(journey.endState(before, after)).toEqual([]);
}
