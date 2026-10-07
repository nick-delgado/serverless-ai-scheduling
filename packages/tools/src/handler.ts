/**
 * What a tool handler is and what it may use: the types and result helpers every handler in
 * `src/tools/` imports. They live here, not in `registry.ts`, so the handlers don't import the module
 * that imports them (#77). `registry.ts` re-exports them, which is how `@sched/tools` exposes them.
 */
import type {
  ConversationId,
  PatientId,
  ToolError,
  ToolErrorCode,
  ToolInput,
  ToolName,
  ToolOutput,
} from "@sched/contracts";

import type { Clock } from "./clock";
import type { Notifier } from "./notify";
import type { Repositories } from "./repos/types";

/** What a handler may use. `patientId` comes from the verified JWT, never from tool input. */
export interface ToolContext {
  readonly patientId: PatientId;
  readonly conversationId: ConversationId;
  readonly clock: Clock;
  readonly repos: Repositories;
  /** Staff notifications (escalate_to_human). Optional: without it, escalations are recorded as FAILED. */
  readonly notifier?: Notifier;
}

export type ToolHandlerResult<N extends ToolName> =
  { ok: true; output: ToolOutput<N> } | { ok: false; error: ToolError };

/** A tool implementation. Input is already validated and defaulted; the output is validated after. */
export type ToolHandler<N extends ToolName> = (
  input: ToolInput<N>,
  ctx: ToolContext,
) => Promise<ToolHandlerResult<N>>;

/** Success result for a handler (the handler's `ToolHandler<N>` return type checks the output shape). */
export function toolOk<O>(output: O): { ok: true; output: O } {
  return { ok: true, output };
}

/** Failure result for a handler. `hint` tells the model what to do next. */
export function toolFail(
  code: ToolErrorCode,
  message: string,
  hint?: string,
): { ok: false; error: ToolError } {
  return { ok: false, error: { error: hint === undefined ? { code, message } : { code, message, hint } } };
}
