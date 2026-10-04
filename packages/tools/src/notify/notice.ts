/**
 * Building an `EscalationNotice` from stored records. One builder serves `escalate_to_human` (the first
 * send) and `scripts/retry-escalations.ts` (re-sends, #35), so a re-sent email says exactly what the first
 * one would have.
 */
import type { ConversationMessage, Escalation, Patient } from "@sched/contracts";

import { formatClinicDateTime } from "../clock";
import type { EscalationNotice, TranscriptLine } from "./index";

/** Patient/assistant text only. Tool results travel in user messages; they are skipped with every non-text block. */
export function transcriptOf(messages: readonly ConversationMessage[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const m of messages) {
    const text = m.content
      .flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
      .filter((t) => t.length > 0)
      .join("\n");
    if (text) lines.push({ role: m.role === "user" ? "patient" : "assistant", text, createdAt: m.createdAt });
  }
  return lines;
}

/** The notice for `escalation`, given the patient's profile (null if none is on file) and the stored messages. */
export function buildEscalationNotice(
  escalation: Escalation,
  patient: Pick<Patient, "firstName" | "lastName" | "dateOfBirth"> | null,
  messages: readonly ConversationMessage[],
): EscalationNotice {
  return {
    escalationId: escalation.escalationId,
    conversationId: escalation.conversationId,
    patient: patient
      ? { firstName: patient.firstName, lastName: patient.lastName, dateOfBirth: patient.dateOfBirth }
      : null,
    reason: escalation.reason,
    summary: escalation.summary,
    createdAt: escalation.createdAt,
    createdLocal: formatClinicDateTime(escalation.createdAt),
    transcript: transcriptOf(messages),
  };
}
