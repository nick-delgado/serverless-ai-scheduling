/**
 * Building and sending an `EscalationNotice` from stored records. `escalate_to_human` (the first send) and
 * `scripts/retry-escalations.ts` (re-sends, #35) share the builder and `sendEscalationNotice`, so both load
 * the same records, build the notice the same way and record the result in the same shape. A re-send is
 * built from the records as stored at retry time: the transcript is the conversation's messages then, which
 * may differ from the first attempt's (later turns, or none once the messages expire).
 */
import {
  LIMITS,
  type ConversationMessage,
  type Escalation,
  type PatientId,
  type Patient,
} from "@sched/contracts";

import { formatClinicDateTime } from "../clock";
import type { Repositories } from "../repos/types";
import type { EscalationNotice, Notifier, TranscriptLine } from "./types";

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

/** `error` as stored on a FAILED notification: `name: message`, capped at the `Escalation` contract's limit, and never empty. */
export function notificationErrorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, LIMITS.escalationNotificationErrorMaxChars) || "Unknown error";
}

/** The result of one send, as it is recorded on the escalation. */
export type SendResult = { status: "SENT"; messageId: string } | { status: "FAILED"; error: string };

/**
 * Load the patient's profile and the conversation's messages, build the notice and send it. Never throws:
 * any failure (a read or the send) comes back as FAILED with its error text. The caller records the result.
 *
 * `patientId` is the caller's: the verified JWT's in the tool (CLAUDE.md rule 1), the stored escalation's in
 * the retry script.
 */
export async function sendEscalationNotice(
  escalation: Escalation,
  patientId: PatientId,
  deps: { repos: Pick<Repositories, "patients" | "conversations">; notifier: Notifier },
): Promise<SendResult> {
  try {
    const [patient, messages] = await Promise.all([
      deps.repos.patients.get(patientId),
      deps.repos.conversations.listMessages(patientId, escalation.conversationId),
    ]);
    const { messageId } = await deps.notifier.notifyEscalation(
      buildEscalationNotice(escalation, patient, messages),
    );
    return { status: "SENT", messageId };
  } catch (error) {
    return { status: "FAILED", error: notificationErrorText(error) };
  }
}
