/**
 * Stored domain entities (ADR-004). camelCase, UTC timestamps. These are what repositories read and
 * write; the model never sees them directly (tools map them to the snake_case shapes in tools.ts).
 */
import { z } from "zod";

import { LIMITS, Specialty } from "./clinic";
import { AppointmentId, ConversationId, EscalationId, PatientId, ProviderId, SlotId, TurnId } from "./ids";
import { IsoDate, IsoDateTimeUtc } from "./primitives";

const Name = z.string().trim().min(1).max(60);

export const Patient = z.strictObject({
  patientId: PatientId,
  firstName: Name,
  lastName: Name,
  dateOfBirth: IsoDate,
  preferredProviderId: ProviderId.optional(),
  createdAt: IsoDateTimeUtc,
});
export type Patient = z.infer<typeof Patient>;

export const Provider = z.strictObject({
  providerId: ProviderId,
  displayName: z.string().min(1).max(80), // "Dr. Priya Lee"
  firstName: Name,
  lastName: Name,
  credentials: z.string().min(1).max(20), // "MD", "DPT"
  specialty: Specialty,
  acceptingNewPatients: z.boolean(),
  bio: z.string().max(500).optional(),
});
export type Provider = z.infer<typeof Provider>;

export const SlotStatus = z.enum(["OPEN", "BOOKED"]);
export type SlotStatus = z.infer<typeof SlotStatus>;

export const Slot = z
  .strictObject({
    slotId: SlotId,
    providerId: ProviderId,
    specialty: Specialty,
    startUtc: IsoDateTimeUtc,
    endUtc: IsoDateTimeUtc,
    status: SlotStatus,
    appointmentId: AppointmentId.optional(),
  })
  .refine((s) => s.endUtc > s.startUtc, { message: "endUtc must be after startUtc", path: ["endUtc"] })
  .refine((s) => (s.status === "BOOKED") === (s.appointmentId !== undefined), {
    message: "A slot has an appointmentId exactly when it is BOOKED",
    path: ["appointmentId"],
  });
export type Slot = z.infer<typeof Slot>;

export const AppointmentStatus = z.enum(["BOOKED", "CANCELLED", "COMPLETED"]);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

export const Appointment = z
  .strictObject({
    appointmentId: AppointmentId,
    patientId: PatientId,
    providerId: ProviderId,
    slotId: SlotId,
    specialty: Specialty,
    startUtc: IsoDateTimeUtc,
    endUtc: IsoDateTimeUtc,
    status: AppointmentStatus,
    reason: z.string().trim().min(1).max(LIMITS.reasonMaxChars),
    createdAt: IsoDateTimeUtc,
    updatedAt: IsoDateTimeUtc,
  })
  .refine((a) => a.endUtc > a.startUtc, { message: "endUtc must be after startUtc", path: ["endUtc"] });
export type Appointment = z.infer<typeof Appointment>;

/**
 * An Anthropic Messages API content block, stored verbatim (text, tool_use, tool_result, thinking, ...).
 * Deliberately loose: the SDK owns these shapes, and history must be replayed byte-for-byte (CLAUDE.md rule 4).
 */
export const ContentBlock = z.looseObject({ type: z.string().min(1) });
export type ContentBlock = z.infer<typeof ContentBlock>;

export const ConversationMessage = z.strictObject({
  conversationId: ConversationId,
  seq: z.int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  content: z.array(ContentBlock).min(1),
  turnId: TurnId,
  createdAt: IsoDateTimeUtc,
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;

export const EscalationReason = z.enum([
  "patient_requested",
  "repeated_failure",
  "frustration",
  "out_of_scope",
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const Escalation = z.strictObject({
  escalationId: EscalationId,
  conversationId: ConversationId,
  patientId: PatientId,
  reason: EscalationReason,
  summary: z.string().trim().min(LIMITS.escalationSummaryMinChars).max(LIMITS.escalationSummaryMaxChars),
  createdAt: IsoDateTimeUtc,
  notification: z.strictObject({
    status: z.enum(["PENDING", "SENT", "FAILED"]),
    messageId: z.string().min(1).optional(),
    error: z.string().max(500).optional(),
  }),
});
export type Escalation = z.infer<typeof Escalation>;
