/**
 * The simulator's shared types and the `SimulatorError` it throws, in a leaf module so `llm.ts` and
 * `replay.ts` don't import `simulator.ts`, which re-exports them (#31). The shapes a results file
 * records (`RejectedReply`, `RecordedSimulatorTurn`) are Zod schemas, declared once here: replay
 * validates with them and the types are inferred from them. Also the token-usage sums the simulator
 * and the runner both keep.
 */
import type { TokenUsage } from "@sched/contracts";
import { z } from "zod";

import type { Scenario } from "../schema";
import type { TranscriptEvent } from "../transcript";

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
export type SimulatorTurn = ({ message: string } | { stop: string }) & {
  cost?: SimulatorCost;
  /** Replies the simulator's guards rejected on the way to this one (never sent). */
  rejected?: RejectedReply[];
};

/** A model reply the simulator didn't send, and why. */
export const RejectedReply = z.object({ reply: z.string(), problems: z.array(z.string()) });
export type RejectedReply = z.infer<typeof RejectedReply>;

/**
 * A simulator turn as a results file records it (`TrialResult.simulatorTurns`): what replay reads, plus
 * any rejected replies, for debugging the simulator.
 */
export const RecordedSimulatorTurn = z.intersection(
  z.object({ turn: z.number().int().positive(), rejected: z.array(RejectedReply).optional() }),
  z.union([z.object({ message: z.string() }), z.object({ stop: z.string() })]),
);
export type RecordedSimulatorTurn = z.infer<typeof RecordedSimulatorTurn>;

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

export const zeroUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

/** A simulator cost of nothing yet: no tokens, no calls. */
export const zeroSimulatorCost = (): SimulatorCost => ({ usage: zeroUsage(), costUsd: 0, llmCalls: 0 });
