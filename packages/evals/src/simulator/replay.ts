/**
 * Deterministic replay of recorded simulator turns (#31), for debugging. Every scenario trial records
 * what its simulator said (`TrialResult.simulatorTurns`); `ReplayPatientSimulator.fromReport` turns a
 * results file back into a simulator that says exactly that again, turn by turn, with no model calls.
 * Pair it with a scripted agent for a fully deterministic rerun, or with a live agent to see how a
 * prompt change handles the same patient (`npm run evals -- --mode scenario --replay <results.json>`).
 *
 * Turns are matched by scenario id, trial number and turn number. A turn the recording doesn't have
 * (the agent run ended differently) stops the conversation with `replay exhausted`; a conversation the
 * recording doesn't have is a `SimulatorError`.
 */
import { z } from "zod";

import {
  RecordedSimulatorTurn,
  SimulatorError,
  type PatientSimulator,
  type SimulatorContext,
  type SimulatorTurn,
} from "./types";
import { issueText } from "../util";

/**
 * The part of a results file (`RunReport`) a replay reads. Trials without `simulatorTurns` (L1 trials)
 * are ignored.
 */
export const ReplaySource = z.object({
  simulator: z.string().optional(),
  cases: z.array(
    z.object({
      id: z.string(),
      trials: z.array(
        z.object({
          trial: z.number().int().positive(),
          simulatorTurns: z.array(RecordedSimulatorTurn).optional(),
        }),
      ),
    }),
  ),
});
export type ReplaySource = z.infer<typeof ReplaySource>;

const keyOf = (scenarioId: string, trial: number) => `${scenarioId}#${String(trial)}`;

export class ReplayPatientSimulator implements PatientSimulator {
  readonly name: string;
  readonly #recordings: ReadonlyMap<string, ReadonlyMap<number, RecordedSimulatorTurn>>;

  /** `recordings`: per `"<scenario id>#<trial>"`, the simulator turns in any order. */
  constructor(recordings: Readonly<Record<string, readonly RecordedSimulatorTurn[]>>, name = "replay") {
    this.name = name;
    this.#recordings = new Map(
      Object.entries(recordings).map(([key, turns]) => [key, new Map(turns.map((t) => [t.turn, t]))]),
    );
  }

  /**
   * A replay of every trial in a results file (parsed JSON) that recorded simulator turns. Throws when
   * the file doesn't have the shape, naming the first bad field.
   */
  static fromReport(json: unknown): ReplayPatientSimulator {
    const parsed = ReplaySource.safeParse(json);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      throw new Error(`not a results file: ${issue === undefined ? "(root): invalid" : issueText(issue)}`);
    }
    const report = parsed.data;
    const recordings: Record<string, readonly RecordedSimulatorTurn[]> = {};
    for (const c of report.cases)
      for (const t of c.trials)
        if (t.simulatorTurns !== undefined) recordings[keyOf(c.id, t.trial)] = t.simulatorTurns;
    return new ReplayPatientSimulator(
      recordings,
      report.simulator === undefined ? "replay" : `replay:${report.simulator}`,
    );
  }

  next(context: SimulatorContext): Promise<SimulatorTurn> {
    const turns = this.#recordings.get(keyOf(context.scenario.id, context.trial));
    if (turns === undefined)
      return Promise.reject(
        new SimulatorError(`no recorded simulator turns for ${keyOf(context.scenario.id, context.trial)}`),
      );
    const recorded = turns.get(context.turn);
    if (recorded === undefined) return Promise.resolve({ stop: "replay exhausted" });
    return Promise.resolve("stop" in recorded ? { stop: recorded.stop } : { message: recorded.message });
  }
}
