/**
 * The Notifier seam (#23): how `escalate_to_human` tells front-desk staff about a handoff (FR-034).
 *
 * Tools depend only on this interface, injected through `ToolContext.notifier` (CLAUDE.md rule 3), so the
 * eval harness and unit tests run with `RecordingNotifier` and never send email. The SES implementation
 * (#35) lives next to this file; the chat handler (#17) wires it.
 *
 * Everything in a notice except the ids is untrusted text (the patient's words, the model's summary):
 * an implementation must escape it for its medium (e.g. HTML email) and never interpret it.
 */
import type { ConversationId, EscalationId, EscalationReason, IsoDateTimeUtc } from "@sched/contracts";

/** One visible line of the conversation. Only text the patient saw or typed; never reasoning or tool internals. */
export interface TranscriptLine {
  role: "patient" | "assistant";
  text: string;
  createdAt: IsoDateTimeUtc;
}

/** What staff receive when a conversation is escalated. */
export interface EscalationNotice {
  escalationId: EscalationId;
  conversationId: ConversationId;
  /** The patient's first name, or null if no profile is on file. */
  patientFirstName: string | null;
  reason: EscalationReason;
  /** The model's summary for staff (untrusted text). */
  summary: string;
  createdAt: IsoDateTimeUtc;
  /** `createdAt` in clinic time, e.g. "Monday, October 5, 2026 at 9:00 AM ET". */
  createdLocal: string;
  /** Ascending by message order. Empty when nothing was stored yet. */
  transcript: TranscriptLine[];
}

export interface NotifyResult {
  /** Provider message id (SES `MessageId`), stored on the escalation record. */
  messageId: string;
}

export interface Notifier {
  /** Deliver the notice to staff. Throws on failure; the caller records FAILED and carries on. */
  notifyEscalation(notice: EscalationNotice): Promise<NotifyResult>;
}

const REASON_LABELS: Record<EscalationReason, string> = {
  patient_requested: "Patient asked for a person",
  repeated_failure: "Repeated failed attempts",
  frustration: "Patient frustrated",
  out_of_scope: "Out-of-scope request",
};

/** A plain-text rendering (subject + body) any notifier can use. Untrusted text is included verbatim, never interpreted. */
export function formatEscalationNotice(notice: EscalationNotice): { subject: string; body: string } {
  const who = notice.patientFirstName ?? "a patient";
  const transcript =
    notice.transcript.length === 0
      ? "(no messages stored)"
      : notice.transcript
          .map((l) => `${l.role === "patient" ? "Patient" : "Assistant"}: ${l.text}`)
          .join("\n\n");
  return {
    subject: `Escalation: ${REASON_LABELS[notice.reason]} (${who})`,
    body: [
      `Patient: ${notice.patientFirstName ?? "(no profile on file)"}`,
      `Reason: ${REASON_LABELS[notice.reason]}`,
      `When: ${notice.createdLocal}`,
      `Escalation: ${notice.escalationId}`,
      `Conversation: ${notice.conversationId}`,
      "",
      "Summary:",
      notice.summary,
      "",
      "Transcript:",
      transcript,
    ].join("\n"),
  };
}

/** In-memory Notifier for tests and evals: records every notice; can be told to fail. */
export class RecordingNotifier implements Notifier {
  readonly sent: EscalationNotice[] = [];
  private failure: Error | undefined;

  constructor(options: { failWith?: Error } = {}) {
    this.failure = options.failWith;
  }

  /** Make subsequent calls throw `error` (or succeed again with `undefined`). */
  failWith(error: Error | undefined): void {
    this.failure = error;
  }

  notifyEscalation(notice: EscalationNotice): Promise<NotifyResult> {
    if (this.failure) return Promise.reject(this.failure);
    this.sent.push(structuredClone(notice));
    return Promise.resolve({ messageId: `recorded-${String(this.sent.length)}` });
  }
}
