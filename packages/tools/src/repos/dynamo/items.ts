/**
 * Single-table key design (ADR-004 and its 2026-09-29 amendment) and the mapping between stored items and
 * @sched/contracts entities. Every item carries `PK`, `SK`, and `entityType`; GSI1 attributes exist only on
 * providers and on OPEN slots (the sparse open-availability index).
 */
import {
  Appointment,
  ConversationMessage,
  Escalation,
  Patient,
  Provider,
  Slot,
  type AppointmentId,
  type ConversationId,
  type PatientId,
  type ProviderId,
  type Specialty,
} from "@sched/contracts";

import { clinicDateOf } from "../../clock";

/** An item as the DocumentClient returns it. */
export type Item = Record<string, unknown>;

export interface Key {
  PK: string;
  SK: string;
}

/** Message items expire 30 days after the message was written (ADR-009). */
export const MESSAGE_TTL_DAYS = 30;

export const PROVIDERS_GSI1PK = "PROVIDERS";

export const keys = {
  patient: (patientId: PatientId): Key => ({ PK: `PATIENT#${patientId}`, SK: "PROFILE" }),
  provider: (providerId: ProviderId): Key => ({ PK: `PROVIDER#${providerId}`, SK: "PROFILE" }),
  /** `startUtc` must be canonical (`YYYY-MM-DDTHH:MM:00Z`), as in slot ids, so keys sort by instant. */
  slot: (providerId: ProviderId, startUtc: string): Key => ({
    PK: `PROVIDER#${providerId}`,
    SK: `SLOT#${startUtc}`,
  }),
  appointment: (patientId: PatientId, appointmentId: AppointmentId): Key => ({
    PK: `PATIENT#${patientId}`,
    SK: `APPT#${appointmentId}`,
  }),
  conversationMeta: (patientId: PatientId, createdAt: string, conversationId: ConversationId): Key => ({
    PK: `PATIENT#${patientId}`,
    SK: `CONV#${createdAt}#${conversationId}`,
  }),
  message: (conversationId: ConversationId, seq: number): Key => ({
    PK: `CONV#${conversationId}`,
    SK: `MSG#${String(seq).padStart(6, "0")}`,
  }),
  /** Fixed per conversation, so `attribute_not_exists(PK)` enforces "at most one escalation" (amendment). */
  escalation: (conversationId: ConversationId): Key => ({ PK: `CONV#${conversationId}`, SK: "ESC" }),
};

/** GSI1 attributes of an OPEN slot: `OPEN#<specialty>#<clinic-local day>` / `<startUtc>#<providerId>`. */
export function openSlotGsi1(
  specialty: Specialty,
  providerId: ProviderId,
  startUtc: string,
): {
  GSI1PK: string;
  GSI1SK: string;
} {
  return { GSI1PK: `OPEN#${specialty}#${clinicDateOf(startUtc)}`, GSI1SK: `${startUtc}#${providerId}` };
}

/** Drop the storage-only attributes, leaving the entity's own fields for its (strict) schema. */
function fields(item: Item, extra: readonly string[] = []): Item {
  const out: Item = {};
  const drop = new Set(["PK", "SK", "GSI1PK", "GSI1SK", "entityType", "expiresAt", ...extra]);
  for (const [k, v] of Object.entries(item)) if (!drop.has(k)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------------------------

export const patientItem = (p: Patient): Item => ({
  ...keys.patient(p.patientId),
  entityType: "PATIENT",
  ...p,
});
export const patientFrom = (item: Item): Patient => Patient.parse(fields(item));

export const providerItem = (p: Provider): Item => ({
  ...keys.provider(p.providerId),
  entityType: "PROVIDER",
  GSI1PK: PROVIDERS_GSI1PK,
  // ADR-004's `<specialty>#<lastName>`, plus the id so equal last names keep a stable order.
  GSI1SK: `${p.specialty}#${p.lastName}#${p.providerId}`,
  ...p,
});
export const providerFrom = (item: Item): Provider => Provider.parse(fields(item));

export const slotItem = (s: Slot): Item => ({
  ...keys.slot(s.providerId, s.startUtc),
  entityType: "SLOT",
  ...(s.status === "OPEN" ? openSlotGsi1(s.specialty, s.providerId, s.startUtc) : {}),
  ...s,
});
export const slotFrom = (item: Item): Slot => Slot.parse(fields(item));

export const appointmentItem = (a: Appointment): Item => ({
  ...keys.appointment(a.patientId, a.appointmentId),
  entityType: "APPOINTMENT",
  ...a,
});
export const appointmentFrom = (item: Item): Appointment => Appointment.parse(fields(item));

export const conversationMetaItem = (
  patientId: PatientId,
  conversationId: ConversationId,
  createdAt: string,
): Item => ({
  ...keys.conversationMeta(patientId, createdAt, conversationId),
  entityType: "CONVERSATION",
  conversationId,
  patientId,
  createdAt,
  expiresAt: expiresAtFor(createdAt),
});

/**
 * Content blocks are stored as one opaque JSON string: the SDK (or #60's provider-neutral blocks) owns
 * their shape, and a string round-trips byte-for-byte (no DynamoDB type coercion of nulls, empty
 * strings, or number precision). `patientId` is the conversation owner (amendment).
 */
export const messageItem = (patientId: PatientId, m: ConversationMessage): Item => ({
  ...keys.message(m.conversationId, m.seq),
  entityType: "MESSAGE",
  patientId,
  conversationId: m.conversationId,
  seq: m.seq,
  role: m.role,
  content: JSON.stringify(m.content),
  turnId: m.turnId,
  createdAt: m.createdAt,
  // Retry de-duplication (#104): on patient messages only, so the attribute is absent, not null, otherwise.
  ...(m.clientMessageId === undefined ? {} : { clientMessageId: m.clientMessageId }),
  expiresAt: expiresAtFor(m.createdAt),
});
export const messageFrom = (item: Item): ConversationMessage => {
  const rest = fields(item, ["patientId"]);
  if (typeof rest.content !== "string") throw new Error(`Message ${String(item.SK)} has no JSON content`);
  return ConversationMessage.parse({ ...rest, content: JSON.parse(rest.content) as unknown });
};

export const escalationItem = (e: Escalation): Item => ({
  ...keys.escalation(e.conversationId),
  entityType: "ESCALATION",
  ...e,
});
export const escalationFrom = (item: Item): Escalation => Escalation.parse(fields(item));

/** DynamoDB TTL wants epoch seconds. */
function expiresAtFor(createdAt: string): number {
  return Math.floor(Date.parse(createdAt) / 1000) + MESSAGE_TTL_DAYS * 24 * 60 * 60;
}
