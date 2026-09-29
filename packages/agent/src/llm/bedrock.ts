/**
 * `LlmClient` on Claude in Amazon Bedrock via bedrock-runtime (`AnthropicBedrock`, US inference profiles).
 * This is the interim decision in ADR-002: Mantle (`AnthropicBedrockMantle`) is unavailable to this
 * account. Switching back later is a change to this file only.
 *
 * Credentials come from the default AWS provider chain (the Lambda role, or `AWS_PROFILE` locally).
 * IAM: `bedrock:InvokeModelWithResponseStream` on the inference-profile and foundation-model ARNs.
 */
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";

import type { LlmCallOptions, LlmClient, LlmRequest, LlmStreamHandlers } from "./client";

export interface BedrockLlmClientOptions {
  /** Defaults to `AWS_REGION`, then `us-east-1`. */
  awsRegion?: string;
  /**
   * SDK retries (408/409/429/5xx and connection errors, with backoff). New accounts throttle quickly
   * (ADR-002), but chat is interactive, so keep this small. Default 3.
   */
  maxRetries?: number;
  /** Per-attempt timeout in milliseconds. Defaults to the SDK's. */
  timeoutMs?: number;
  /** A pre-built client, used as-is (tests inject one with a fake `fetch`). Overrides the options above. */
  client?: AnthropicBedrock;
}

export class BedrockLlmClient implements LlmClient {
  readonly #client: AnthropicBedrock;

  constructor(options: BedrockLlmClientOptions = {}) {
    this.#client =
      options.client ??
      new AnthropicBedrock({
        awsRegion: options.awsRegion ?? process.env.AWS_REGION ?? "us-east-1",
        maxRetries: options.maxRetries ?? 3,
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      });
  }

  async streamMessage(
    request: LlmRequest,
    handlers: LlmStreamHandlers = {},
    options: LlmCallOptions = {},
  ): Promise<Anthropic.Message> {
    const stream = this.#client.messages.stream(
      request,
      options.signal ? { signal: options.signal } : undefined,
    );
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        handlers.onContentBlockStart?.(event.content_block);
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        handlers.onTextDelta?.(event.delta.text);
      }
    }
    return stream.finalMessage();
  }
}
