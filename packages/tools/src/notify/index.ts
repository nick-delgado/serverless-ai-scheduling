/**
 * The Notifier seam (#23): how `escalate_to_human` tells front-desk staff about a handoff (FR-034).
 *
 * Tools depend only on this interface, injected through `ToolContext.notifier` (CLAUDE.md rule 3), so the
 * eval harness and unit tests run with `RecordingNotifier` and never send email. The SES implementation
 * (#35) is `./ses.ts`, a separate entry point (`@sched/tools/ses`); the chat handler wires it (#36).
 *
 * Everything in a notice except the ids is untrusted text (the patient's words, the model's summary):
 * an implementation must escape it for its medium (e.g. HTML email) and never interpret it.
 */
import type {
  ConversationId,
  EscalationId,
  EscalationReason,
  IsoDate,
  IsoDateTimeUtc,
} from "@sched/contracts";

export * from "./notice";
export * from "./render";

/** One visible line of the conversation. Only text the patient saw or typed; never reasoning or tool internals. */
export interface TranscriptLine {
  role: "patient" | "assistant";
  text: string;
  createdAt: IsoDateTimeUtc;
}

/** How front-desk staff match a patient (they have no dashboard to resolve ids). */
export interface PatientIdentity {
  firstName: string;
  lastName: string;
  dateOfBirth: IsoDate;
}

/** What staff receive when a conversation is escalated. */
export interface EscalationNotice {
  escalationId: EscalationId;
  conversationId: ConversationId;
  /** Name and date of birth, so staff can find the patient's chart; null if no profile is on file. */
  patient: PatientIdentity | null;
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

/** In-memory Notifier for tests and evals: records every notice; can be told to fail. */
export class RecordingNotifier implements Notifier {
  readonly sent: EscalationNotice[] = [];
  private failure: Error | undefined;

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
