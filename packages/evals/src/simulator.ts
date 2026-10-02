/**
 * The patient side of a multi-turn run (ADR-008). The runner only needs the `PatientSimulator` interface.
 * Scripted turns (`script`) are sent by the runner before the simulator is consulted, so red-team payloads
 * are byte-identical on every run (#33).
 *
 * Implementations:
 * - `scriptOnlySimulator`: nothing beyond the script (unscripted scenarios skip);
 * - `QueuedPatientSimulator`: fixed messages, for tests;
 * - `LlmPatientSimulator` (`simulator/llm.ts`, #31): an LLM plays the persona toward the goal;
 * - `ReplayPatientSimulator` (`simulator/replay.ts`, #31): replays the turns a results file recorded.
 */
import type { TokenUsage } from "@sched/contracts";

import type { Scenario } from "./schema";
import type { TranscriptEvent } from "./transcript";

export interface SimulatorContext {
  scenario: Scenario;
  /** The 1-based trial number, so a replay can find the conversation it recorded. */
  trial: number;
  /** Everything so far, in order. */
  events: readonly TranscriptEvent[];
  /** The 1-based number of the patient turn about to be sent. */
  turn: number;
  /** The assistant's visible text from the last turn ("" before the first). */
  lastAssistantText: string;
}

/** What one simulator turn cost: every model call it made, retries included. */
export interface SimulatorCost {
  usage: TokenUsage;
  costUsd: number;
  llmCalls: number;
}

/**
 * - `message`: the next patient message.
 * - `stop`: end the conversation (goal met, patient gave up, escalated, …). ADR-008 stop conditions.
 *
 * `cost` is set by simulators that call a model; the runner adds it to the trial's accounting.
 */
export type SimulatorTurn = ({ message: string } | { stop: string }) & { cost?: SimulatorCost };

/** A simulator turn as a results file records it (`TrialResult.simulatorTurns`), for replay. */
export type RecordedSimulatorTurn = { turn: number } & ({ message: string } | { stop: string });

export interface PatientSimulator {
  /** Name recorded in results, e.g. `script-only`, `llm:sonnet-4.6:sim.v1`, `replay`. */
  readonly name: string;
  next(context: SimulatorContext): Promise<SimulatorTurn>;
}

/**
 * A simulator turn that couldn't be produced (the model kept breaking the rules, or a replay has no
 * recording). The runner records the trial as `error`, with the cost spent so far.
 */
export class SimulatorError extends Error {
  override readonly name = "SimulatorError";
  readonly cost: SimulatorCost | undefined;

  constructor(message: string, cost?: SimulatorCost) {
    super(message);
    this.cost = cost;
  }
}

/** Sends nothing beyond the scenario's `script`: the run ends when the script does. */
export const scriptOnlySimulator: PatientSimulator = {
  name: "script-only",
  next: () => Promise.resolve({ stop: "script exhausted" }),
};

/** Replays fixed messages after the script, then stops. For tests and deterministic self-checks. */
export class QueuedPatientSimulator implements PatientSimulator {
  readonly name = "queued";
  readonly #messages: string[];

  constructor(messages: readonly string[]) {
    this.#messages = [...messages];
  }

  next(): Promise<SimulatorTurn> {
    const message = this.#messages.shift();
    return Promise.resolve(message === undefined ? { stop: "queue exhausted" } : { message });
  }
}

export * from "./simulator/guards";
export * from "./simulator/llm";
export * from "./simulator/prompt";
export * from "./simulator/replay";
