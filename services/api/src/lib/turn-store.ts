/**
 * Per-turn bookkeeping the chat handler owns: the per-patient daily turn cap (ADR-009) and the per-turn
 * trace (FR-051). Two implementations: in-memory (tests, evals) and DynamoDB (`dynamo-turn-store.ts`).
 *
 * Neither is a repository the tools use, so it lives with the handler, not in `packages/tools`.
 */
import { TurnTrace, type IsoDate, type PatientId } from "@sched/contracts";

export type ConsumeTurnResult =
  /** Counted. `used` includes this turn. */
  | { ok: true; used: number }
  /** The patient already used `cap` turns today. Nothing was counted. */
  | { ok: false; used: number };

export interface TurnStore {
  /**
   * Atomically count one agent turn for the patient on `day` (clinic-local date), unless `cap` turns are
   * already counted. Concurrent calls can't overshoot the cap.
   */
  consumeDailyTurn(patientId: PatientId, day: IsoDate, cap: number): Promise<ConsumeTurnResult>;
  /** Store the turn's trace. Write-once per turn; it carries tool inputs, so it never goes to logs. */
  saveTrace(patientId: PatientId, trace: TurnTrace): Promise<void>;
}

export interface InMemoryTurnStore extends TurnStore {
  turnsUsed(patientId: PatientId, day: IsoDate): number;
  /** Stored traces, in save order. */
  readonly traces: { patientId: PatientId; trace: TurnTrace }[];
}

export function createInMemoryTurnStore(): InMemoryTurnStore {
  const counts = new Map<string, number>();
  const traces: { patientId: PatientId; trace: TurnTrace }[] = [];
  const key = (patientId: string, day: string) => `${patientId}#${day}`;
  return {
    traces,
    turnsUsed: (patientId, day) => counts.get(key(patientId, day)) ?? 0,
    consumeDailyTurn(patientId, day, cap) {
      const used = counts.get(key(patientId, day)) ?? 0;
      if (used >= cap) return Promise.resolve({ ok: false, used });
      counts.set(key(patientId, day), used + 1);
      return Promise.resolve({ ok: true, used: used + 1 });
    },
    saveTrace(patientId, trace) {
      if (traces.some((t) => t.trace.turnId === trace.turnId)) {
        return Promise.reject(new Error(`Trace for turn ${trace.turnId} already stored`));
      }
      traces.push({ patientId, trace: structuredClone(TurnTrace.parse(trace)) });
      return Promise.resolve();
    },
  };
}
