/** The Notifier seam's types (#23), imported by the implementations here without going through `./index`. */
import type {
  ConversationId,
  EscalationId,
  EscalationReason,
  IsoDate,
  IsoDateTimeUtc,
} from "@sched/contracts";

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
