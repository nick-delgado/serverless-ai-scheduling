/**
 * Per-turn bookkeeping the chat handler owns: the daily turn caps, per patient and for the whole env
 * (ADR-009, #356), and the per-turn trace (FR-051). Two implementations: in-memory (tests, evals) and DynamoDB (`dynamo-turn-store.ts`).
 *
 * Neither is a repository the tools use, so it lives with the handler, not in `packages/tools`.
 */
import { TurnTrace, type IsoDate, type PatientId } from "@sched/contracts";

export type ConsumeTurnResult =
  /** Counted against both the patient's day and the env's day. */
  | { ok: true }
  /**
   * A cap was already reached, and nothing was counted against either. `patient` wins when both
   * refuse (#356, A-3).
   */
  | { ok: false; refusedBy: "patient" | "env" };

export interface DailyTurnCaps {
  /** Turns one patient may use per clinic-local day. */
  patient: number;
  /** Turns the whole env accepts per clinic-local day, across all patients. */
  env: number;
}

export interface TurnStore {
  /**
   * Atomically count one agent turn for the patient and for the env on `day` (clinic-local date), unless
   * either cap is already reached. A refused turn counts against neither. Concurrent calls can't
   * overshoot either cap.
   */
  consumeDailyTurn(patientId: PatientId, day: IsoDate, caps: DailyTurnCaps): Promise<ConsumeTurnResult>;
  /** Store the turn's trace. Write-once per turn; it carries tool inputs, so it never goes to logs. */
  saveTrace(patientId: PatientId, trace: TurnTrace): Promise<void>;
}

export interface InMemoryTurnStore extends TurnStore {
  turnsUsed(patientId: PatientId, day: IsoDate): number;
  /** Turns counted for the whole env on `day`. */
  envTurnsUsed(day: IsoDate): number;
  /** Stored traces, in save order. */
  readonly traces: { patientId: PatientId; trace: TurnTrace }[];
}

export function createInMemoryTurnStore(): InMemoryTurnStore {
  const counts = new Map<string, number>();
  const traces: { patientId: PatientId; trace: TurnTrace }[] = [];
  const key = (patientId: string, day: string) => `${patientId}#${day}`;
  // "ENV" can't be a patient ID (a UUID), so the two kinds of key never collide.
  const envKey = (day: string) => `ENV#${day}`;
  return {
    traces,
    turnsUsed: (patientId, day) => counts.get(key(patientId, day)) ?? 0,
    envTurnsUsed: (day) => counts.get(envKey(day)) ?? 0,
    consumeDailyTurn(patientId, day, caps) {
      const patientUsed = counts.get(key(patientId, day)) ?? 0;
      if (patientUsed >= caps.patient) return Promise.resolve({ ok: false, refusedBy: "patient" });
      const envUsed = counts.get(envKey(day)) ?? 0;
      if (envUsed >= caps.env) return Promise.resolve({ ok: false, refusedBy: "env" });
      counts.set(key(patientId, day), patientUsed + 1);
      counts.set(envKey(day), envUsed + 1);
      return Promise.resolve({ ok: true });
    },
    saveTrace(patientId, trace) {
      if (traces.some((t) => t.trace.turnId === trace.turnId)) {
        return Promise.reject(new Error(`Trace for turn ${trace.turnId} already stored`));
      }
      // Reject, don't throw: callers see the same failure shape as the DynamoDB store's.
      const parsed = TurnTrace.safeParse(trace);
      if (!parsed.success) return Promise.reject(parsed.error);
      traces.push({ patientId, trace: structuredClone(parsed.data) });
      return Promise.resolve();
    },
  };
}
