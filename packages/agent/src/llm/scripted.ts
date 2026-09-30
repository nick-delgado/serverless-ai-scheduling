/**
 * A test double for `LlmClient` that replays queued responses, with no network (ADR-001). It records a
 * deep copy of every request, and streams each text block as fixed-size deltas, so runs are
 * deterministic. The eval harness and handler integration tests can use it too.
 *
 * Like the real client, it tags every reasoning block with the request's `family` and `modelId`, so
 * scripted reasoning follows the same replay rules as real reasoning.
 */
import type { ContentBlock, TokenUsage, ToolUseBlock } from "@sched/contracts";

import type {
  LlmCallOptions,
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmStreamHandlers,
} from "./types";

/** What one scripted model call returns. */
export interface ScriptedResponse {
  content: ContentBlock[];
  stopReason: LlmStopReason;
  /** Defaults to `stopReason`. */
  providerStopReason?: string;
  /** Defaults: 100 input, 20 output, no cache tokens. */
  usage?: Partial<TokenUsage>;
}

/**
 * One queued step: a response, an error to throw (e.g. a throttling error after retries), or a function
 * that builds the response from the request (and may await, e.g. to hold a call open in a test).
 */
export type ScriptedStep =
  | ScriptedResponse
  | { error: unknown }
  | ((request: LlmRequest) => ScriptedResponse | Promise<ScriptedResponse>);

export interface ScriptedLlmClientOptions {
  /** Characters per streamed text delta. Default 12. */
  chunkSize?: number;
}

export class ScriptedLlmClient implements LlmClient {
  /** A deep copy of each request, in call order. */
  readonly requests: LlmRequest[] = [];
  readonly #steps: ScriptedStep[];
  readonly #chunkSize: number;

  constructor(steps: ScriptedStep[] = [], options: ScriptedLlmClientOptions = {}) {
    this.#steps = [...steps];
    this.#chunkSize = Math.max(1, options.chunkSize ?? 12);
  }

  /** Queue more steps. */
  enqueue(...steps: ScriptedStep[]): this {
    this.#steps.push(...steps);
    return this;
  }

  /** Steps not consumed yet. */
  get remaining(): number {
    return this.#steps.length;
  }

  async streamMessage(
    request: LlmRequest,
    handlers: LlmStreamHandlers = {},
    options: LlmCallOptions = {},
  ): Promise<LlmResponse> {
    const callIndex = this.requests.length;
    this.requests.push(structuredClone(request));
    options.signal?.throwIfAborted();

    const step = this.#steps.shift();
    if (step === undefined) {
      throw new Error(`ScriptedLlmClient: no scripted response left for call #${callIndex}`);
    }
    if (typeof step !== "function" && "error" in step) throw step.error;
    const response = toResponse(typeof step === "function" ? await step(request) : step, request);

    for (const block of response.content) {
      await Promise.resolve();
      handlers.onContentBlockStart?.({ type: block.type });
      if (block.type !== "text") continue;
      for (let i = 0; i < block.text.length; i += this.#chunkSize) {
        await Promise.resolve();
        options.signal?.throwIfAborted();
        handlers.onTextDelta?.(block.text.slice(i, i + this.#chunkSize));
      }
    }
    return response;
  }
}

function toResponse(scripted: ScriptedResponse, request: LlmRequest): LlmResponse {
  const usage = scripted.usage ?? {};
  return {
    content: structuredClone(scripted.content).map((block) =>
      block.type === "reasoning" ? { ...block, family: request.family, modelId: request.modelId } : block,
    ),
    stopReason: scripted.stopReason,
    providerStopReason: scripted.providerStopReason ?? scripted.stopReason,
    usage: {
      inputTokens: usage.inputTokens ?? 100,
      outputTokens: usage.outputTokens ?? 20,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Builders for common responses
// ---------------------------------------------------------------------------------------------

let toolUseSeq = 0;

export interface ScriptedToolUse {
  /** Defaults to a unique `tooluse_scripted_<n>`. */
  id?: string;
  name: string;
  input: unknown;
}

type Extras = { reasoning?: string; usage?: ScriptedResponse["usage"] };

function reasoningBlocks(reasoning: string | undefined): ContentBlock[] {
  // family/modelId are placeholders: the client re-tags them from the request.
  return reasoning === undefined
    ? []
    : [
        {
          type: "reasoning",
          family: "scripted",
          modelId: "scripted",
          text: reasoning,
          signature: `sig_${reasoning.length}`,
        },
      ];
}

const textBlock = (text: string): ContentBlock => ({ type: "text", text });

/** A final answer (`end_turn`). */
export function scriptedText(text: string, extras: Extras = {}): ScriptedResponse {
  return {
    content: [...reasoningBlocks(extras.reasoning), textBlock(text)],
    stopReason: "end_turn",
    usage: extras.usage,
  };
}

/** One or more parallel tool calls (`tool_use`), optionally after a short text preamble. */
export function scriptedToolUse(
  calls: ScriptedToolUse[],
  extras: Extras & { text?: string } = {},
): ScriptedResponse {
  return {
    content: [
      ...reasoningBlocks(extras.reasoning),
      ...(extras.text === undefined ? [] : [textBlock(extras.text)]),
      ...calls.map((call): ToolUseBlock => ({
        type: "tool_use",
        id: call.id ?? `tooluse_scripted_${String(++toolUseSeq).padStart(4, "0")}`,
        name: call.name,
        input: call.input,
      })),
    ],
    stopReason: "tool_use",
    usage: extras.usage,
  };
}

/** A refusal (e.g. Converse `content_filtered`), optionally after some partial text (a mid-stream decline). */
export function scriptedRefusal(
  extras: { partialText?: string; providerStopReason?: string } = {},
): ScriptedResponse {
  return {
    content: extras.partialText === undefined ? [] : [textBlock(extras.partialText)],
    stopReason: "refusal",
    providerStopReason: extras.providerStopReason ?? "content_filtered",
  };
}

/** Output cut off at `max_tokens`: partial reasoning and/or partial text. */
export function scriptedMaxTokens(
  extras: { partialText?: string; reasoning?: string } = {},
): ScriptedResponse {
  return {
    content: [
      ...reasoningBlocks(extras.reasoning ?? "…"),
      ...(extras.partialText === undefined ? [] : [textBlock(extras.partialText)]),
    ],
    stopReason: "max_tokens",
  };
}

/** Unusable output (Converse `malformed_tool_use`), optionally after partial text. */
export function scriptedMalformed(extras: { partialText?: string } = {}): ScriptedResponse {
  return {
    content: extras.partialText === undefined ? [] : [textBlock(extras.partialText)],
    stopReason: "malformed_output",
    providerStopReason: "malformed_tool_use",
  };
}
