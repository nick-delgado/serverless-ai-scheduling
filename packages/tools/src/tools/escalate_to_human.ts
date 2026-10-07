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
 * - The summary carries no IDs (#107): before the escalation is recorded, every ID-shaped token in it is
 *   replaced with `[ID removed]`, so the stored record, the staff notice and any retry re-send are clean.
 *   The prompt already asks for this, and Nova Pro once ignored it. This is a guard, not a check: it
 *   never rejects the call. An ID-shaped token is any of these (case-insensitive):
 *   - a GUID, 8-4-4-4-12 hex (patient IDs are Cognito subs), wherever no digit touches it: a GUID
 *     glued to any letter (`uuid<GUID>`, `<GUID>abc`), an underscore or a hyphen (`patient_<GUID>`)
 *     is still caught, while a digit next to it (`0<GUID>`, `<GUID>0`) means it isn't a GUID. A
 *     longer hex run that begins or ends with a-f loses its GUID-shaped part: an accepted false positive;
 *   - `appt_`, `slot_`, `prov_` or `esc_` followed by letters, digits or underscores (looser than the
 *     contract formats, so a typed `appt_123` is caught too), starting a word: `my_appt_1` stays;
 *   - a fixture alias, `pat-` followed by letters, as a whole word.
 *   The placeholder keeps a summary that was only an ID above the 10-character minimum; the result is
 *   capped at the 1,000-character maximum, since a short ID can grow. It covers the summary only: the
 *   staff transcript still shows the patient's own words, and traces keep the model's raw input.
 *
 * Identity comes from ctx.patientId / ctx.conversationId (bound by the caller), never from input.
 */
import { CLINIC, LIMITS, type Escalation } from "@sched/contracts";

import { sendEscalationNotice } from "../notify/notice";
import { toolFail, toolOk, type ToolContext, type ToolHandler } from "../handler";

function notifyStaff(escalation: Escalation, ctx: ToolContext): Promise<Escalation["notification"]> {
  if (!ctx.notifier) return Promise.resolve({ status: "FAILED", error: "No notifier configured" });
  return sendEscalationNotice(escalation, ctx.patientId, { repos: ctx.repos, notifier: ctx.notifier });
}

export const ID_PLACEHOLDER = "[ID removed]";

const ID_SHAPED_TOKENS: readonly RegExp[] = [
  /(?<![0-9])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9])/gi,
  /\b(?:appt|slot|prov|esc)_\w+/gi,
  /\bpat-[a-z]+\b/gi,
];

/** `summary` with every ID-shaped token replaced (see the header), capped at the stored maximum. */
function redactIds(summary: string): string {
  const redacted = ID_SHAPED_TOKENS.reduce((text, pattern) => text.replace(pattern, ID_PLACEHOLDER), summary);
  return redacted.slice(0, LIMITS.escalationSummaryMaxChars);
}

export const escalateToHuman: ToolHandler<"escalate_to_human"> = async (input, ctx) => {
  const recorded = await ctx.repos.escalations.record({
    patientId: ctx.patientId,
    conversationId: ctx.conversationId,
    reason: input.reason,
    summary: redactIds(input.summary),
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
