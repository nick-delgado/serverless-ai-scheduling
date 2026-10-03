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
 *
 * The shared types and `SimulatorError` live in `simulator/types.ts`, re-exported here.
 */
import type { PatientSimulator, SimulatorTurn } from "./simulator/types";

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
export * from "./simulator/types";
