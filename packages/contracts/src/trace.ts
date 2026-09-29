/**
 * Per-turn trace (ADR-001, FR-051): every model call and tool call in one agent turn. The chat handler
 * persists it; the eval harness grades trajectories from it. It never contains patient identifiers
 * beyond what tool inputs carry (and tool inputs never carry a patient ID).
 */
import { z } from "zod";

import { ConversationId, TurnId } from "./ids";
import { IsoDateTimeUtc, TokenUsage } from "./primitives";
import { ToolErrorCode, ToolName } from "./tools";

const ms = z.int().nonnegative();

export const LlmCallTrace = z.strictObject({
  index: z.int().nonnegative(),
  modelId: z.string().min(1),
  startedAt: IsoDateTimeUtc,
  durationMs: ms,
  /** Time to the first streamed content block, when streaming. */
  ttftMs: ms.optional(),
  stopReason: z.string().min(1),
  usage: TokenUsage,
});
export type LlmCallTrace = z.infer<typeof LlmCallTrace>;

export const ToolCallTrace = z.strictObject({
  toolUseId: z.string().min(1),
  name: ToolName,
  input: z.unknown(),
  ok: z.boolean(),
  errorCode: ToolErrorCode.optional(),
  durationMs: ms,
});
export type ToolCallTrace = z.infer<typeof ToolCallTrace>;

export const TurnOutcome = z.enum(["completed", "iteration_limit", "refusal", "max_tokens", "error"]);
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
