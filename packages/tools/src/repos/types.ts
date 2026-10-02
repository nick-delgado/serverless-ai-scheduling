/**
 * Repository interfaces (ADR-004). Two implementations share these contracts: in-memory (this package,
 * for unit tests and evals) and DynamoDB (#13). Both must pass `test/contract/repositories.contract.ts`.
 *
 * Each method maps to one ADR-004 access pattern, noted as `AP-n` with the DynamoDB operation, so the
 * DynamoDB implementation is a 1:1 translation.
 *
 * Conventions:
 * - Anything patient-owned is addressed by `(patientId, ...)`. The patientId always comes from the
 *   verified JWT via ToolContext (CLAUDE.md rule 1). Another patient's data reads as "not found".
 * - Entities are validated with the @sched/contracts schemas on the way in and returned as fresh copies.
 * - Expected business outcomes (slot taken, appointment not found) are typed results, never throws.
 *   Throws are reserved for caller bugs (schema-invalid input) and broken invariants; the tool executor
 *   turns them into INTERNAL.
 * - Writes that touch more than one item are atomic (CLAUDE.md rule 2): all of it happens or none of it.
 */
import type {
  Appointment,
  AppointmentId,
  ConversationId,
  ConversationMessage,
  Escalation,
  EscalationId,
  EscalationReason,
  IsoDate,
  IsoDateTimeUtc,
  Patient,
  PatientId,
  Provider,
  ProviderId,
  Slot,
  SlotId,
  Specialty,
  ToolErrorCode,
} from "@sched/contracts";

// ---------------------------------------------------------------------------------------------
// Patients and providers
// ---------------------------------------------------------------------------------------------

export interface PatientRepo {
  /** AP-1. GetItem `PATIENT#<sub> / PROFILE`. */
  get(patientId: PatientId): Promise<Patient | null>;
}

export interface ProviderFilter {
  specialty?: Specialty;
  /**
   * Part of a name as a patient says it ("Lee", "Dr. Okafor", "priya"). Case-insensitive; honorifics
   * are ignored; every word must prefix-match the provider's first or last name. See `providerMatchesName`.
   */
  nameQuery?: string;
}

export interface ProviderRepo {
  /** GetItem `PROVIDER#<id> / PROFILE`. */
  get(providerId: ProviderId): Promise<Provider | null>;
  /**
   * AP-3. Query GSI1 `PROVIDERS`, `begins_with(GSI1SK, "<specialty>#")` when a specialty is given; the
   * name filter is applied in code with `providerMatchesName` (DynamoDB `contains` is case-sensitive).
   * Ordered by GSI1SK: specialty, then last name, then providerId.
   */
  list(filter?: ProviderFilter): Promise<Provider[]>;
}

// ---------------------------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------------------------

/** Half-open UTC range `[fromUtc, toUtc)` on slot start. Compare as instants, not strings. */
export interface UtcRange {
  fromUtc: IsoDateTimeUtc;
  toUtc: IsoDateTimeUtc;
}

export interface SlotRepo {
  /** GetItem `PROVIDER#<id> / SLOT#<startUtc>` (both recoverable from the slotId). Malformed ids read as null. */
  get(slotId: SlotId): Promise<Slot | null>;
  /**
   * AP-4. OPEN slots for one provider whose start is in `range`, ascending by start.
   * Query `PROVIDER#<id>`, SK between `SLOT#<from>` and `SLOT#<to>`, filter `status = OPEN`.
   */
  listOpenByProvider(providerId: ProviderId, range: UtcRange): Promise<Slot[]>;
  /**
   * AP-5. OPEN slots in a specialty on one clinic-local day (`clinicDateOf(startUtc)`), ascending by start,
   * then providerId. Query the sparse GSI1 `OPEN#<specialty>#<day>`; GSI1SK is `<startUtc>#<providerId>`.
   */
  listOpenBySpecialtyAndDay(specialty: Specialty, day: IsoDate): Promise<Slot[]>;
}

// ---------------------------------------------------------------------------------------------
// Appointments: booking and rescheduling (NFR-008)
// ---------------------------------------------------------------------------------------------

export interface BookCommand {
  patientId: PatientId;
  slotId: SlotId;
  /** Visit reason in the patient's words; trimmed, 1..LIMITS.reasonMaxChars (invalid → throws). */
  reason: string;
}

export type BookFailureReason =
  /** No such slot. */
  | "SLOT_NOT_FOUND"
  /** The slot is BOOKED by someone else (or by this patient's non-BOOKED appointment). */
  | "SLOT_UNAVAILABLE";

export type BookResult =
  | {
      ok: true;
      appointment: Appointment;
      /**
       * True when this patient already held the slot (a retried or duplicated tool call). Nothing new was
       * written; `appointment` is the existing one, including its original reason.
       */
      alreadyBooked: boolean;
    }
  | { ok: false; reason: BookFailureReason };

export interface RescheduleCommand {
  patientId: PatientId;
  appointmentId: AppointmentId;
  newSlotId: SlotId;
}

export type RescheduleFailureReason =
  /** No such appointment for this patient (including: it belongs to someone else). */
  | "APPOINTMENT_NOT_FOUND"
  /** The appointment is CANCELLED or COMPLETED. */
  | "APPOINTMENT_NOT_BOOKED"
  /** The appointment is already in `newSlotId` (e.g. a retried call after success). Nothing changed. */
  | "SAME_SLOT"
  | "SLOT_NOT_FOUND"
  | "SLOT_UNAVAILABLE"
  /**
   * The appointment changed between the implementation's read and its conditional write (optimistic
   * concurrency, e.g. DynamoDB). The in-memory implementation never returns it. Nothing changed; retry.
   */
  | "CONFLICT";

export type RescheduleResult =
  | { ok: true; appointment: Appointment; previous: Appointment }
  | { ok: false; reason: RescheduleFailureReason };

export interface AppointmentRepo {
  /** GetItem `PATIENT#<sub> / APPT#<id>`: another patient's appointment reads as null. */
  get(patientId: PatientId, appointmentId: AppointmentId): Promise<Appointment | null>;
  /** AP-2. Every appointment of the patient (all statuses), ascending by start. Query `PATIENT#<sub>`, `begins_with(SK, "APPT#")`. */
  listForPatient(patientId: PatientId): Promise<Appointment[]>;
  /**
   * AP-6. Book an OPEN slot: slot OPEN → BOOKED (+appointmentId, GSI1 attrs removed) and a new BOOKED
   * appointment, atomically. `TransactWriteItems`: Update slot (condition `status = OPEN`) + Put appointment
   * (condition `attribute_not_exists(PK)`).
   *
   * Idempotent (ADR-004): if the slot is already BOOKED by a BOOKED appointment of this same patient, returns
   * that appointment with `alreadyBooked: true`. Of N concurrent calls for one slot, exactly one books it;
   * the others get SLOT_UNAVAILABLE (other patients) or `alreadyBooked` (same patient).
   *
   * Does not check that the slot is in the future; that is a tool-level rule (it needs the Clock's "now").
   */
  book(command: BookCommand): Promise<BookResult>;
  /**
   * AP-7. Move the patient's BOOKED appointment to an OPEN slot, all-or-nothing. `TransactWriteItems`:
   * - release the old slot (condition `appointmentId = :appt`) → OPEN, GSI1 attrs restored;
   * - book the new slot (condition `status = OPEN`) → BOOKED, appointmentId set, GSI1 attrs removed;
   * - update the appointment (condition `status = BOOKED AND slotId = :oldSlot`; the key scopes it to the patient)
   *   → new slotId/providerId/specialty/start/end, `updatedAt` = now. Same appointmentId and createdAt.
   *
   * Any failure leaves all three items exactly as they were. The new slot may be with another provider or
   * specialty; whether that is allowed is a tool-level decision.
   */
  reschedule(command: RescheduleCommand): Promise<RescheduleResult>;
}

/** Suggested ToolError code for each repository failure, so every tool maps them the same way. */
export const TOOL_ERROR_CODE_FOR: Record<BookFailureReason | RescheduleFailureReason, ToolErrorCode> = {
  SLOT_NOT_FOUND: "NOT_FOUND",
  SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
  APPOINTMENT_NOT_FOUND: "NOT_FOUND",
  APPOINTMENT_NOT_BOOKED: "NOT_ALLOWED",
  SAME_SLOT: "INVALID_INPUT", // reschedule_appointment answers SAME_SLOT as a success (`already_rescheduled`)
  CONFLICT: "INTERNAL",
};

// ---------------------------------------------------------------------------------------------
// Conversations (append-only, CLAUDE.md rule 4)
// ---------------------------------------------------------------------------------------------

/** Most messages one `append` call may write (a DynamoDB transaction holds 100 items). */
export const MAX_APPEND_BATCH = 50;

export interface ConversationSummary {
  conversationId: ConversationId;
  patientId: PatientId;
  /** `createdAt` of message seq 0. */
  createdAt: IsoDateTimeUtc;
}

export type ConversationAppendErrorCode =
  /** A message with one of these seqs already exists (a concurrent turn won). Nothing was written. */
  | "SEQ_CONFLICT"
  /**
   * The batch starts at seq n > 0 but this patient has no message n-1 in that conversation: unknown
   * conversation, another patient's conversation, or a gap. Nothing was written.
   */
  | "PREDECESSOR_MISSING";

/** Thrown by `ConversationRepo.append`. A conflict means the caller's view of history is stale: fail the turn. */
export class ConversationAppendError extends Error {
  override readonly name = "ConversationAppendError";
  readonly code: ConversationAppendErrorCode;
  readonly conversationId: ConversationId;
  readonly seq: number;

  constructor(code: ConversationAppendErrorCode, conversationId: ConversationId, seq: number) {
    super(`${code}: conversation ${conversationId}, seq ${seq}`);
    this.code = code;
    this.conversationId = conversationId;
    this.seq = seq;
  }
}

export interface ConversationRepo {
  /**
   * AP-8 (write). Append consecutive messages of one conversation, all-or-nothing, never overwriting.
   * Seq 0 starts a conversation owned by `patientId`; a batch starting at n > 0 requires this patient's
   * message n-1. `TransactWriteItems`: ConditionCheck `CONV#<id> / MSG#<n-1>` (`patientId = :sub`) when n > 0,
   * Put each `MSG#<seq>` (`attribute_not_exists(PK)`, patientId stored as an extra attribute), and, when n = 0,
   * Put the meta item `PATIENT#<sub> / CONV#<createdAt>#<id>`.
   *
   * Throws ConversationAppendError on conflict; throws RangeError for an empty, oversized, mixed-conversation,
   * or non-consecutive batch; throws a ZodError for a schema-invalid message.
   */
  append(patientId: PatientId, messages: readonly ConversationMessage[]): Promise<void>;
  /** AP-8 (read). Messages ascending by seq, exactly as appended. [] for an unknown or another patient's conversation. */
  listMessages(patientId: PatientId, conversationId: ConversationId): Promise<ConversationMessage[]>;
  /** The patient's conversations, newest first. Query `PATIENT#<sub>`, `begins_with(SK, "CONV#")`, descending. */
  listConversations(patientId: PatientId, options?: { limit?: number }): Promise<ConversationSummary[]>;
}

// ---------------------------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------------------------

export interface NewEscalation {
  patientId: PatientId;
  conversationId: ConversationId;
  reason: EscalationReason;
  summary: string;
  /** Defaults to `{ status: "PENDING" }`. */
  notification?: Escalation["notification"];
}

export type RecordEscalationResult =
  | {
      ok: true;
      escalation: Escalation;
      /** True when this conversation was already escalated; the existing record is returned unchanged. */
      alreadyEscalated: boolean;
    }
  /** The conversation already has an escalation that belongs to a different patient. Nothing was written. */
  | { ok: false; reason: "NOT_OWNER" };

export interface EscalationRepo {
  /**
   * AP-9. Record the conversation's escalation, atomically at most once per conversation (the
   * escalate_to_human rule, #23). The id comes from the IdGenerator and `createdAt` from the Clock.
   * DynamoDB: Put with `attribute_not_exists(PK)` on a fixed per-conversation key such as `CONV#<id> / ESC`
   * (ADR-004 lists `ESC#<createdIso>`, which cannot enforce at-most-once; amendment proposed in #5).
   */
  record(input: NewEscalation): Promise<RecordEscalationResult>;
  /** The conversation's escalation, or null (also null when it belongs to another patient). */
  getForConversation(patientId: PatientId, conversationId: ConversationId): Promise<Escalation | null>;
  /** Set the delivery status after notifying staff. Returns the updated record, or null if none is visible to this patient. */
  updateNotification(
    patientId: PatientId,
    conversationId: ConversationId,
    notification: Escalation["notification"],
  ): Promise<Escalation | null>;
}

// ---------------------------------------------------------------------------------------------
// Bundle and injected dependencies
// ---------------------------------------------------------------------------------------------

export interface Repositories {
  patients: PatientRepo;
  providers: ProviderRepo;
  slots: SlotRepo;
  appointments: AppointmentRepo;
  conversations: ConversationRepo;
  escalations: EscalationRepo;
}

/** Id source, injected so tests and evals get deterministic ids (see `sequentialIds`). */
export interface IdGenerator {
  appointmentId(): AppointmentId;
  escalationId(): EscalationId;
}
