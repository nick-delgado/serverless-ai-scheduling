/**
 * The one seam between the agent and a model provider (ADR-001, ADR-010). Handlers and tools never call
 * Bedrock directly; they go through an `LlmClient`, which speaks only these provider-neutral types.
 *
 * Content blocks are the stored ones from `@sched/contracts` (text, tool_use, tool_result, reasoning), so
 * a response is appended to history as-is and replayed unchanged (CLAUDE.md rule 4). Requests may also
 * carry `cache_point` markers, which exist only on request copies and are never stored.
 */
import type {
  ContentBlock,
  ContentBlockType,
  ModelToolDefinition,
  ReasoningBlock,
  TextBlock,
  TokenUsage,
  ToolResultBlock,
  ToolUseBlock,
} from "@sched/contracts";

export type { ContentBlock, ReasoningBlock, TextBlock, ToolResultBlock, ToolUseBlock };

/**
 * A prompt-cache checkpoint: everything before it (tools → system → messages) is cacheable. Markers go
 * only where the model profile says the model accepts them (ADR-010): `profileRequest` places the system
 * one, the loop the rolling message one.
 */
export interface CachePoint {
  readonly type: "cache_point";
}

export const CACHE_POINT: CachePoint = Object.freeze({ type: "cache_point" });

export type LlmRole = "user" | "assistant";

/** A stored message, as the loop keeps it in history. */
export interface LlmMessage {
  role: LlmRole;
  content: ContentBlock[];
}

/** A message in a request: stored content plus optional cache markers. */
export interface LlmRequestMessage {
  role: LlmRole;
  content: (ContentBlock | CachePoint)[];
}

export interface LlmSystemText {
  type: "text";
  text: string;
}

export interface LlmRequest {
  /** Bedrock model or inference-profile ID. */
  modelId: string;
  /** The profile's replay family; the client tags every reasoning block it returns with it. */
  family: string;
  system: (LlmSystemText | CachePoint)[];
  /** Tools in a stable order (stable bytes keep the prompt cache warm). */
  tools: readonly ModelToolDefinition[];
  messages: LlmRequestMessage[];
  /** Output cap. Reasoning tokens count against it. */
  maxTokens: number;
  /** Provider-specific request fields from the model profile (Converse `additionalModelRequestFields`). */
  modelFields: Readonly<Record<string, unknown>>;
  /**
   * For models that write chain-of-thought inline in visible text (Nova Pro: `<thinking>…</thinking>`):
   * the tag name. The client removes every section in that tag, and in `<thinking>` (stripped for every
   * profile, #107), from the visible text before it streams, and keeps the removed text as a reasoning
   * block. Without a tag, `<thinking>` sections are still removed, and dropped.
   */
  inlineReasoningTag?: string;
}

/**
 * Why a response ended, normalized across providers:
 * - `refusal`: the model or a provider filter declined (Converse `guardrail_intervened`, `content_filtered`).
 * - `context_window_exceeded`: the request no longer fits the model's context.
 * - `malformed_output`: unusable output (Converse `malformed_tool_use`, `malformed_model_output`, or tool
 *   input that isn't valid JSON).
 */
export const LLM_STOP_REASONS = [
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "refusal",
  "context_window_exceeded",
  "malformed_output",
] as const;
export type LlmStopReason = (typeof LLM_STOP_REASONS)[number];

export interface LlmResponse {
  /** Every block in order: reasoning, text, and tool calls. Empty text blocks are dropped. */
  content: ContentBlock[];
  stopReason: LlmStopReason;
  /** The provider's raw stop reason, for traces. */
  providerStopReason: string;
  /** `inputTokens` excludes cache reads and writes (Converse semantics, same as the Messages API). */
  usage: TokenUsage;
}

/** Callbacks fired while a response streams. Both are optional and synchronous. */
export interface LlmStreamHandlers {
  /** A content block started. The first call marks time to first token. */
  onContentBlockStart?: (block: { type: ContentBlockType }) => void;
  /** A delta of visible text, in order. Reasoning and tool-input deltas are not reported. */
  onTextDelta?: (text: string) => void;
}

export interface LlmCallOptions {
  /** Aborts the in-flight request (e.g. the Lambda is about to time out). */
  signal?: AbortSignal;
}

export interface LlmClient {
  /**
   * Stream one model call and resolve with the complete response.
   *
   * Rejects on transport or API errors after the client's own retries. A refusal, `max_tokens`, or
   * malformed output is NOT an error: it resolves normally and the caller checks `stopReason`.
   */
  streamMessage(
    request: LlmRequest,
    handlers?: LlmStreamHandlers,
    options?: LlmCallOptions,
  ): Promise<LlmResponse>;
}
