/**
 * A test double for `LlmClient` that replays queued responses, with no network (ADR-001). It records a
 * deep copy of every request, and streams each text block as fixed-size deltas, so runs are
 * deterministic. The eval harness and handler integration tests can use it too.
 */
import type Anthropic from "@anthropic-ai/sdk";

import type { LlmCallOptions, LlmClient, LlmRequest, LlmStreamHandlers } from "./client";

/** What one scripted model call returns. The fake fills in the rest of the `Message`. */
export interface ScriptedResponse {
  content: Anthropic.ContentBlock[];
  stop_reason: Anthropic.StopReason;
  stop_details?: Anthropic.RefusalStopDetails | null;
  usage?: Partial<
    Pick<
      Anthropic.Usage,
      "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
    >
  >;
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
  ): Promise<Anthropic.Message> {
    const callIndex = this.requests.length;
    this.requests.push(structuredClone(request));
    options.signal?.throwIfAborted();

    const step = this.#steps.shift();
    if (step === undefined) {
      throw new Error(`ScriptedLlmClient: no scripted response left for call #${callIndex}`);
    }
    if (typeof step !== "function" && "error" in step) throw step.error;
    const response = typeof step === "function" ? await step(request) : step;

    const message = toMessage(response, request.model, callIndex);
    for (const block of message.content) {
      await Promise.resolve();
      handlers.onContentBlockStart?.({ type: block.type });
      if (block.type !== "text") continue;
      for (let i = 0; i < block.text.length; i += this.#chunkSize) {
        await Promise.resolve();
        options.signal?.throwIfAborted();
        handlers.onTextDelta?.(block.text.slice(i, i + this.#chunkSize));
      }
    }
    return message;
  }
}

function toMessage(response: ScriptedResponse, model: string, index: number): Anthropic.Message {
  const usage = response.usage ?? {};
  return {
    id: `msg_scripted_${String(index).padStart(3, "0")}`,
    type: "message",
    role: "assistant",
    model,
    content: structuredClone(response.content),
    stop_reason: response.stop_reason,
    stop_sequence: null,
    stop_details:
      response.stop_details ??
      (response.stop_reason === "refusal" ? { type: "refusal", category: null, explanation: null } : null),
    container: null,
    diagnostics: null,
    usage: {
      input_tokens: usage.input_tokens ?? 100,
      output_tokens: usage.output_tokens ?? 20,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Builders for common responses
// ---------------------------------------------------------------------------------------------

let toolUseSeq = 0;

export interface ScriptedToolUse {
  /** Defaults to a unique `toolu_scripted_<n>`. */
  id?: string;
  name: string;
  input: unknown;
}

type Extras = { thinking?: string; usage?: ScriptedResponse["usage"] };

function thinkingBlocks(thinking: string | undefined): Anthropic.ThinkingBlock[] {
  return thinking === undefined ? [] : [{ type: "thinking", thinking, signature: `sig_${thinking.length}` }];
}

function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null };
}

/** A final answer (`end_turn`). */
export function scriptedText(text: string, extras: Extras = {}): ScriptedResponse {
  return {
    content: [...thinkingBlocks(extras.thinking), textBlock(text)],
    stop_reason: "end_turn",
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
      ...thinkingBlocks(extras.thinking),
      ...(extras.text === undefined ? [] : [textBlock(extras.text)]),
      ...calls.map((call): Anthropic.ToolUseBlock => ({
        type: "tool_use",
        id: call.id ?? `toolu_scripted_${String(++toolUseSeq).padStart(4, "0")}`,
        name: call.name,
        input: call.input,
        caller: { type: "direct" },
      })),
    ],
    stop_reason: "tool_use",
    usage: extras.usage,
  };
}

/** A refusal, optionally after some partial text (a mid-stream decline). */
export function scriptedRefusal(
  extras: { partialText?: string; category?: Anthropic.RefusalStopDetails["category"] } = {},
): ScriptedResponse {
  return {
    content: extras.partialText === undefined ? [] : [textBlock(extras.partialText)],
    stop_reason: "refusal",
    stop_details: { type: "refusal", category: extras.category ?? null, explanation: null },
  };
}

/** Output cut off at `max_tokens`: partial thinking and/or partial text. */
export function scriptedMaxTokens(
  extras: { partialText?: string; thinking?: string } = {},
): ScriptedResponse {
  return {
    content: [
      ...thinkingBlocks(extras.thinking ?? "…"),
      ...(extras.partialText === undefined ? [] : [textBlock(extras.partialText)]),
    ],
    stop_reason: "max_tokens",
  };
}
