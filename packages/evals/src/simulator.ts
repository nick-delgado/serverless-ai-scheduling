/**
 * The patient side of a multi-turn run. The LLM patient simulator (persona + goal + hidden facts) is
 * #31; the runner only needs this interface. Scripted turns (`script`) are sent by the runner before the
 * simulator is consulted, so red-team payloads are byte-identical on every run (#33).
 */
import type { Scenario } from "./schema";
import type { TranscriptEvent } from "./transcript";

export interface SimulatorContext {
  scenario: Scenario;
  /** Everything so far, in order. */
  events: readonly TranscriptEvent[];
  /** The 1-based number of the patient turn about to be sent. */
  turn: number;
  /** The assistant's visible text from the last turn ("" before the first). */
  lastAssistantText: string;
}

/**
 * - `message`: the next patient message.
 * - `stop`: end the conversation (goal met, patient gave up, escalated, …). ADR-008 stop conditions.
 */
export type SimulatorTurn = { message: string } | { stop: string };

export interface PatientSimulator {
  /** Name recorded in results, e.g. `script-only`, `llm:sonnet-4.6` (#31). */
  readonly name: string;
  next(context: SimulatorContext): Promise<SimulatorTurn>;
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
