/**
 * Per-turn trace (ADR-001, FR-051): every model call and tool call in one agent turn. The chat handler
 * persists it; the eval harness grades trajectories from it. It never contains patient identifiers
 * beyond what tool inputs carry (and tool inputs never carry a patient ID).
 */
import { z } from "zod";

import { ConversationId, TurnId } from "./ids";
import { IsoDateTimeUtc, TokenUsage } from "./primitives";
import { TOOL_NAMES, ToolErrorCode } from "./tools";

const ms = z.int().nonnegative();

export const LlmCallTrace = z.strictObject({
  index: z.int().nonnegative(),
  /**
   * 0 for a fresh model call; 1, 2, ... for retries of the same step after a discarded response
   * (`max_tokens`, refusal, malformed output). Every attempt is billed, so every attempt is traced.
   */
  attempt: z.int().nonnegative(),
  modelId: z.string().min(1),
  startedAt: IsoDateTimeUtc,
  durationMs: ms,
  /** Time to the first streamed content block, when streaming. */
  ttftMs: ms.optional(),
  /** The neutral stop reason the loop acted on (`LlmStopReason` in `packages/agent`), or `error`. */
  stopReason: z.string().min(1),
  /** The provider's own stop reason when it differs (e.g. `guardrail_intervened` for a neutral `refusal`). */
  providerStopReason: z.string().min(1).optional(),
  usage: TokenUsage,
});
export type LlmCallTrace = z.infer<typeof LlmCallTrace>;

/** Longest tool name kept in a trace. A model-invented name is truncated to this. */
export const TRACE_TOOL_NAME_MAX = 128;

const knownToolNames: ReadonlySet<string> = new Set(TOOL_NAMES);

export const ToolCallTrace = z
  .strictObject({
    toolUseId: z.string().min(1),
    /** The tool name as the model wrote it (truncated). Only a `ToolName` when `known`. */
    name: z.string().min(1).max(TRACE_TOOL_NAME_MAX),
    /** False when the model called a tool it was never offered; the call was answered NOT_FOUND, never run. */
    known: z.boolean(),
    input: z.unknown(),
    ok: z.boolean(),
    errorCode: ToolErrorCode.optional(),
    durationMs: ms,
  })
  .refine((t) => !t.known || knownToolNames.has(t.name), {
    message: "A known tool call must name a real tool",
    path: ["name"],
  });
export type ToolCallTrace = z.infer<typeof ToolCallTrace>;

/**
 * How a turn ended. `context_window_exceeded`: the conversation no longer fits the model's context.
 * `malformed_output`: the model produced unusable output (e.g. a malformed tool call) twice in a row.
 */
export const TurnOutcome = z.enum([
  "completed",
  "iteration_limit",
  "refusal",
  "max_tokens",
  "context_window_exceeded",
  "malformed_output",
  "error",
]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;

export const TurnTrace = z.strictObject({
  turnId: TurnId,
  conversationId: ConversationId,
  modelProfile: z.string().min(1),
  modelId: z.string().min(1),
  promptVersion: z.string().min(1),
  startedAt: IsoDateTimeUtc,
  durationMs: ms,
  iterations: z.int().nonnegative(),
  llmCalls: z.array(LlmCallTrace),
  toolCalls: z.array(ToolCallTrace),
  usage: TokenUsage,
  outcome: TurnOutcome,
});
export type TurnTrace = z.infer<typeof TurnTrace>;
