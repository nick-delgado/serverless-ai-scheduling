/**
 * The one seam between the agent and a model provider (ADR-001, ADR-002). Handlers and tools never call
 * Bedrock directly; they go through an `LlmClient`. Request and response shapes are the Anthropic SDK's
 * own Messages API types, so there's nothing to translate and new API fields flow through untouched.
 */
import type Anthropic from "@anthropic-ai/sdk";

/** A Messages API request body. The client always streams, so `stream` is not part of it. */
export type LlmRequest = Omit<Anthropic.MessageCreateParamsNonStreaming, "stream">;

/** Callbacks fired while a response streams. Both are optional and synchronous. */
export interface LlmStreamHandlers {
  /** A content block started (thinking, text, tool_use, ...). The first call marks time to first token. */
  onContentBlockStart?: (block: { type: string }) => void;
  /** A text delta from the current `text` block, in order. Thinking and tool-input deltas are not reported. */
  onTextDelta?: (text: string) => void;
}

export interface LlmCallOptions {
  /** Aborts the in-flight request (e.g. the Lambda is about to time out). */
  signal?: AbortSignal;
}

export interface LlmClient {
  /**
   * Stream one Messages API call and resolve with the complete message (stop reason, usage, and every
   * content block, including thinking blocks, exactly as returned).
   *
   * Rejects on transport or API errors after the client's own retries. A refusal or `max_tokens` stop is
   * NOT an error: it resolves normally and the caller checks `stop_reason`.
   */
  streamMessage(
    request: LlmRequest,
    handlers?: LlmStreamHandlers,
    options?: LlmCallOptions,
  ): Promise<Anthropic.Message>;
}
