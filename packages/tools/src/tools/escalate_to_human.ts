/**
 * escalate_to_human (FR-034, ADR-009): hand the conversation to front-desk staff.
 *
 * - At most once per conversation: `escalations.record` is the atomic check (no read-then-write), so of
 *   N concurrent calls exactly one notifies staff; the rest answer `already_escalated: true`.
 * - Staff get the patient's name and date of birth, the reason, the model's summary, and the visible transcript
 *   (text blocks only: no reasoning, tool calls, or tool results).
 * - The patient is never left without the human path: if the notifier is missing or fails, the
 *   escalation is still recorded (notification FAILED) and the phone number and hours are still returned.
 *
 * Identity comes from ctx.patientId / ctx.conversationId (bound by the caller), never from input.
 */
import { CLINIC, type Escalation } from "@sched/contracts";

import { sendEscalationNotice } from "../notify/notice";
import { toolFail, toolOk, type ToolContext, type ToolHandler } from "../registry";

function notifyStaff(escalation: Escalation, ctx: ToolContext): Promise<Escalation["notification"]> {
  if (!ctx.notifier) return Promise.resolve({ status: "FAILED", error: "No notifier configured" });
  return sendEscalationNotice(escalation, ctx.patientId, { repos: ctx.repos, notifier: ctx.notifier });
}

export const escalateToHuman: ToolHandler<"escalate_to_human"> = async (input, ctx) => {
  const recorded = await ctx.repos.escalations.record({
    patientId: ctx.patientId,
    conversationId: ctx.conversationId,
    reason: input.reason,
    summary: input.summary,
  });
  if (!recorded.ok) {
    // The conversation id belongs to someone else: a caller bug or tampering. Say nothing about the
    // other record, but still give the patient the human path.
    return toolFail(
      "NOT_FOUND",
      "This conversation could not be handed to staff.",
      `Apologize and ask the patient to call the front desk at ${CLINIC.phone} (${CLINIC.hours}).`,
    );
  }

  const done = toolOk({
    escalation_id: recorded.escalation.escalationId,
    phone: CLINIC.phone,
    hours: CLINIC.hours,
    already_escalated: recorded.alreadyEscalated,
  });
  // A retry (or a concurrent duplicate) never notifies staff a second time.
  if (recorded.alreadyEscalated) return done;

  const notification = await notifyStaff(recorded.escalation, ctx);
  try {
    await ctx.repos.escalations.updateNotification(ctx.patientId, ctx.conversationId, notification);
  } catch {
    // The record stays PENDING, which is visible to operators. The patient still gets the phone number.
  }
  return done;
};
