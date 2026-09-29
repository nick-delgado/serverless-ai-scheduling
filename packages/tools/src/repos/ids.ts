import { randomUUID } from "node:crypto";

import { AppointmentId, EscalationId } from "@sched/contracts";

import type { IdGenerator } from "./types";

/** Production ids: `appt_<32 hex>` / `esc_<32 hex>` from `crypto.randomUUID()`. */
export function randomIds(): IdGenerator {
  const hex = (): string => randomUUID().replaceAll("-", "");
  return {
    appointmentId: () => AppointmentId.parse(`appt_${hex()}`),
    escalationId: () => EscalationId.parse(`esc_${hex()}`),
  };
}

/**
 * Deterministic ids for tests and evals: `appt_0000000001`, `appt_0000000002`, ... (one counter per kind).
 * The zero-padded shape can't collide with the ULID-style ids in the clinic fixture.
 */
export function sequentialIds(start = 1): IdGenerator {
  let appt = start;
  let esc = start;
  const pad = (n: number): string => String(n).padStart(10, "0");
  return {
    appointmentId: () => AppointmentId.parse(`appt_${pad(appt++)}`),
    escalationId: () => EscalationId.parse(`esc_${pad(esc++)}`),
  };
}
