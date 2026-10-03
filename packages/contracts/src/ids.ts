import { z } from "zod";

/**
 * Cognito user `sub`. Patient identity comes from the verified JWT only (CLAUDE.md rule 1).
 * `z.guid()` (8-4-4-4-12 hex), not `z.uuid()`: real subs aren't always RFC 9562 UUIDs. The dev pool
 * issued one with version digit 7 and variant digit `d`, which `z.uuid()` rejects (#17).
 */
export const PatientId = z.guid();
export type PatientId = z.infer<typeof PatientId>;

export const ProviderId = z.string().regex(/^prov_[a-z0-9]+(?:_[a-z0-9]+)*$/, "Expected prov_<slug>");
export type ProviderId = z.infer<typeof ProviderId>;

/** `slot_<provider slug>_<YYYYMMDDTHHMMZ>`: encodes the table key (ADR-004) so tools can address a slot directly. */
export const SlotId = z
  .string()
  .regex(/^slot_[a-z0-9]+(?:_[a-z0-9]+)*_\d{8}T\d{4}Z$/, "Expected slot_<provider>_<YYYYMMDDTHHMMZ>");
export type SlotId = z.infer<typeof SlotId>;

export const AppointmentId = z.string().regex(/^appt_[0-9A-Za-z]{10,40}$/, "Expected appt_<id>");
export type AppointmentId = z.infer<typeof AppointmentId>;

export const EscalationId = z.string().regex(/^esc_[0-9A-Za-z]{10,40}$/, "Expected esc_<id>");
export type EscalationId = z.infer<typeof EscalationId>;

export const ConversationId = z.uuid();
export type ConversationId = z.infer<typeof ConversationId>;

export const TurnId = z.uuid();
export type TurnId = z.infer<typeof TurnId>;

/** Display/stream message ID, e.g. `msg_000012` (the conversation-local sequence number). */
export const MessageId = z.string().regex(/^msg_\d{6}$/, "Expected msg_<6-digit seq>");
export type MessageId = z.infer<typeof MessageId>;

export function messageIdForSeq(seq: number): MessageId {
  if (!Number.isInteger(seq) || seq < 0 || seq > 999_999) throw new RangeError(`Invalid message seq: ${seq}`);
  return `msg_${String(seq).padStart(6, "0")}`;
}

/** Canonical UTC form used in keys and slot IDs: `YYYY-MM-DDTHH:MM:00Z` (minute precision). */
export function toCanonicalUtc(instant: Date | string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid instant: ${String(instant)}`);
  if (d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) {
    throw new RangeError(`Slot instants must be on a whole minute: ${d.toISOString()}`);
  }
  return `${d.toISOString().slice(0, 16)}:00Z`;
}

export function makeSlotId(providerId: ProviderId, startUtc: Date | string): SlotId {
  const slug = ProviderId.parse(providerId).slice("prov_".length);
  const iso = toCanonicalUtc(startUtc); // 2026-10-13T18:30:00Z
  const compact = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
  return `slot_${slug}_${compact}`;
}

export function parseSlotId(slotId: string): { providerId: ProviderId; startUtc: string } | null {
  if (!SlotId.safeParse(slotId).success) return null;
  const cut = slotId.lastIndexOf("_");
  const slug = slotId.slice("slot_".length, cut);
  const c = slotId.slice(cut + 1); // 20261013T1830Z
  const startUtc = `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T${c.slice(9, 11)}:${c.slice(11, 13)}:00Z`;
  if (
    Number.isNaN(new Date(startUtc).getTime()) ||
    new Date(startUtc).toISOString().slice(0, 16) !== startUtc.slice(0, 16)
  ) {
    return null;
  }
  return { providerId: `prov_${slug}`, startUtc };
}
