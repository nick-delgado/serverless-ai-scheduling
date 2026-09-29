/**
 * Ports the agent loop consumes. They're owned here (the consumer) and implemented elsewhere.
 * `packages/tools` implements `ToolExecutor` structurally, without importing this package
 * (coordination decision on #15 for the parallel run of #5, #7, and #15).
 */
import type { ModelToolDefinition, ToolError } from "@sched/contracts";

/** One `tool_use` block from the model, as the executor sees it. */
export interface ToolCall {
  id: string;
  name: string;
  /** Model-supplied input. Untrusted: the executor validates it against the tool's input schema. */
  input: unknown;
}

export type ToolExecutionResult = { ok: true; output: unknown } | { ok: false; error: ToolError };

/**
 * Runs tool calls for one patient. The caller (the chat handler, or the eval harness) binds the patient
 * identity from the verified JWT when it creates the executor, so the loop never sees, needs, or passes
 * a patient ID (CLAUDE.md rule 1).
 *
 * `execute` should resolve with `{ ok: false }` for every expected failure (bad input, slot taken, ...).
 * If it throws anyway, the loop turns that into an `INTERNAL` tool error; it never propagates.
 */
export interface ToolExecutor {
  /** The `tools` array sent to the model, in a stable order (`toolDefinitionsForModel()`). */
  readonly definitions: readonly ModelToolDefinition[];
  execute(call: ToolCall): Promise<ToolExecutionResult>;
}

/** Wall-clock time. Frozen in tests and evals (CLAUDE.md rule 3). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
