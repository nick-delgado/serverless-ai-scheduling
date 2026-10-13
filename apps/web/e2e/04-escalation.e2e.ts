/**
 * Escalation (#40), on Chromium, last (r1/Q-1 (a)). FR-034 escalates in the same reply without asking first, so the
 * request's own turn must run `escalate_to_human` and show its chip, and the reply must give the front desk's number
 * (a fixed fact, not wording). `e2e` sends the staff email (r1/Q-5 (b)): the conversation's `ESC` record must show the
 * notification SENT within 30 s of the turn's end. Signing in fresh starts a new conversation (FR-014), so FR-034's
 * once-per-conversation rule never refuses a later run.
 */
import { CLINIC } from "@sched/contracts";
import { expect, test } from "@playwright/test";

import { escalationProblems } from "./lib/turns";
import { sendTurn, signIn, observePage } from "./support/chat";
import { e2eEnv, patientLogin } from "./support/env";
import { openTable } from "./support/table";

const NOTIFICATION_DEADLINE_MS = 30_000;

test("escalation: escalated in the request's turn, and the staff email SENT", async ({ page }) => {
  const env = e2eEnv();
  const login = patientLogin(env);
  const table = await openTable(env);

  await observePage(page);
  await signIn(page, login, "Sofia");
  const turn = await sendTurn(page, 0, "I'd like to speak with someone at the front desk, please.");
  expect(escalationProblems(turn, CLINIC.phone)).toEqual([]);

  const conversationId = turn.conversationId;
  if (!conversationId) throw new Error("The turn's stream named no conversation");
  let status: string | undefined;
  await expect
    .poll(
      async () => {
        status = (await table.escalation(login.sub, conversationId))?.notification.status;
        return status;
      },
      { timeout: NOTIFICATION_DEADLINE_MS, intervals: [1_000, 2_000] },
    )
    .toBe("SENT");
  console.log(`escalation for conversation ${conversationId}: notification ${String(status)}`);
});
