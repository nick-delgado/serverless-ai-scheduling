/**
 * `LlmClient` over the Amazon Bedrock Converse API (`ConverseStream`), the single model transport
 * (ADR-010). One adapter serves Claude, Amazon Nova, and OpenAI gpt-oss: per-model differences come
 * from the request (the model profile's `modelFields`, cache-point placement, and inline reasoning tag),
 * never from branches on model names here.
 *
 * Inline chain-of-thought (#107): every text block runs through `InlineReasoningFilter`, which removes
 * `<thinking>…</thinking>` for every profile, plus the profile's own `inlineReasoningTag` (gpt-oss:
 * `<reasoning>`), anywhere in the text, before any of it streams. A profile with a tag keeps the removed
 * text as a reasoning block; for one without, it is dropped. The full rule is on the class.
 *
 * Credentials come from the default AWS provider chain (the Lambda role, or `AWS_PROFILE` locally).
 * IAM: `bedrock:InvokeModelWithResponseStream` on each inference-profile ARN and the foundation-model
 * ARNs it routes to (Converse uses the InvokeModel actions).
 *
 * Wire facts verified live in spike S-1c (`spikes/s1c-converse/`):
 * - Text and reasoning blocks get no `contentBlockStart`; only tool calls do. A block starts at its
 *   first delta.
 * - Claude's reasoning signature arrives as its own delta after the reasoning text, and must be sent
 *   back with it on the next call of a tool-use turn.
 * - gpt-oss may send an empty text block before its reasoning; empty text blocks are dropped.
 */
import {
  BedrockRuntimeClient,
  type ContentBlock as ConverseContentBlock,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
  type Message as ConverseMessage,
  type SystemContentBlock,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { ContentBlock, ContentBlockType, TokenUsage } from "@sched/contracts";

import type {
  CachePoint,
  LlmCallOptions,
  LlmClient,
  LlmRequest,
  LlmRequestMessage,
  LlmResponse,
  LlmStopReason,
  LlmStreamHandlers,
} from "./types";

/** The slice of `BedrockRuntimeClient` this adapter uses (tests inject a fake). */
export interface ConverseSender {
  send(
    command: ConverseStreamCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ stream?: AsyncIterable<ConverseStreamOutput> }>;
}

export interface ConverseLlmClientOptions {
  /** Defaults to `AWS_REGION`, then `us-east-1`. */
  region?: string;
  /**
   * SDK attempts per call, including the first (throttling and 5xx retry with backoff). New accounts
   * throttle quickly (ADR-002), but chat is interactive, so keep this small. Default 3.
   */
  maxAttempts?: number;
  /** A pre-built client, used as-is. Overrides the options above. */
  client?: ConverseSender;
}

export class ConverseLlmClient implements LlmClient {
  readonly #client: ConverseSender;

  constructor(options: ConverseLlmClientOptions = {}) {
    this.#client =
      options.client ??
      (new BedrockRuntimeClient({
        region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
        maxAttempts: options.maxAttempts ?? 3,
      }) as ConverseSender);
  }

  async streamMessage(
    request: LlmRequest,
    handlers: LlmStreamHandlers = {},
    options: LlmCallOptions = {},
  ): Promise<LlmResponse> {
    const response = await this.#client.send(
      new ConverseStreamCommand(toConverseRequest(request)),
      options.signal ? { abortSignal: options.signal } : undefined,
    );
    if (!response.stream) throw new Error("ConverseStream returned no stream");
    const assembler = new ResponseAssembler(request, handlers);
    for await (const event of response.stream) {
      options.signal?.throwIfAborted();
      assembler.push(event);
    }
    return assembler.finish();
  }
}

// ---------------------------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------------------------

const CONVERSE_CACHE_POINT = { cachePoint: { type: "default" } } as const;

const isCachePoint = (block: { type: string }): block is CachePoint => block.type === "cache_point";

/** Neutral request → `ConverseStream` input. Exported for tests. */
export function toConverseRequest(request: LlmRequest): ConverseStreamCommandInput {
  const system: SystemContentBlock[] = request.system.map((block) =>
    isCachePoint(block) ? CONVERSE_CACHE_POINT : { text: block.text },
  );
  const tools: Tool[] = request.tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      // The SDK types JSON documents as its own DocumentType; a JSON Schema object is one.
      inputSchema: { json: tool.inputSchema as never },
    },
  }));
  return {
    modelId: request.modelId,
    system,
    messages: mergeConsecutiveRoles(request.messages).map(toConverseMessage),
    ...(tools.length === 0 ? {} : { toolConfig: { tools } }),
    inferenceConfig: { maxTokens: request.maxTokens },
    ...(Object.keys(request.modelFields).length === 0
      ? {}
      : { additionalModelRequestFields: structuredClone(request.modelFields) as never }),
  };
}

/**
 * Converse wants strictly alternating roles. History can hold two user messages in a row (a turn whose
 * reply was empty stores no assistant message), so adjacent same-role messages are merged in the copy.
 */
function mergeConsecutiveRoles(messages: readonly LlmRequestMessage[]): LlmRequestMessage[] {
  const merged: LlmRequestMessage[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last?.role === message.role) last.content = [...last.content, ...message.content];
    else merged.push({ role: message.role, content: [...message.content] });
  }
  return merged;
}

function toConverseMessage(message: LlmRequestMessage): ConverseMessage {
  return { role: message.role, content: message.content.map(toConverseBlock) };
}

function toConverseBlock(block: ContentBlock | CachePoint): ConverseContentBlock {
  switch (block.type) {
    case "cache_point":
      return CONVERSE_CACHE_POINT;
    case "text":
      return { text: block.text };
    case "tool_use":
      return { toolUse: { toolUseId: block.id, name: block.name, input: (block.input ?? {}) as never } };
    case "tool_result":
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: [{ text: block.content }],
          ...(block.isError ? { status: "error" as const } : {}),
        },
      };
    case "reasoning":
      if (block.redactedContent !== undefined) {
        return { reasoningContent: { redactedContent: Buffer.from(block.redactedContent, "base64") } };
      }
      return {
        reasoningContent: {
          reasoningText: {
            text: block.text ?? "",
            ...(block.signature === undefined ? {} : { signature: block.signature }),
          },
        },
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Response assembly
// ---------------------------------------------------------------------------------------------

type BlockState =
  | { kind: "text"; text: string; filter: InlineReasoningFilter }
  | { kind: "reasoning"; text: string; signature: string; redacted: Uint8Array[] }
  | { kind: "tool_use"; id: string; name: string; json: string };

const STOP_REASONS: Readonly<Record<string, LlmStopReason>> = {
  end_turn: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  refusal: "refusal",
  guardrail_intervened: "refusal",
  content_filtered: "refusal",
  model_context_window_exceeded: "context_window_exceeded",
  malformed_model_output: "malformed_output",
  malformed_tool_use: "malformed_output",
};

/** Converse stop reason → neutral. Unknown values are treated as `end_turn` (the trace keeps the raw one). */
export function toLlmStopReason(raw: string | undefined): LlmStopReason {
  return (raw !== undefined && STOP_REASONS[raw]) || "end_turn";
}

const STREAM_EXCEPTIONS = [
  "internalServerException",
  "modelStreamErrorException",
  "serviceUnavailableException",
  "throttlingException",
  "validationException",
] as const;

/** Folds `ConverseStream` events into a neutral response, firing stream handlers as it goes. Exported for tests. */
export class ResponseAssembler {
  readonly #request: LlmRequest;
  readonly #handlers: LlmStreamHandlers;
  readonly #blocks = new Map<number, BlockState>();
  #rawStop: string | undefined;
  #usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  constructor(request: LlmRequest, handlers: LlmStreamHandlers) {
    this.#request = request;
    this.#handlers = handlers;
  }

  push(event: ConverseStreamOutput): void {
    for (const key of STREAM_EXCEPTIONS) {
      const error = (event as unknown as Record<string, unknown>)[key];
      if (error !== undefined)
        throw error instanceof Error ? error : new Error(`${key}: ${JSON.stringify(error)}`);
    }
    if (event.contentBlockStart) {
      const { start, contentBlockIndex = 0 } = event.contentBlockStart;
      if (start?.toolUse) {
        this.#open(contentBlockIndex, {
          kind: "tool_use",
          id: start.toolUse.toolUseId ?? "",
          name: start.toolUse.name ?? "",
          json: "",
        });
      }
    } else if (event.contentBlockDelta) {
      const { delta, contentBlockIndex = 0 } = event.contentBlockDelta;
      if (delta?.text !== undefined) this.#text(contentBlockIndex, delta.text);
      else if (delta?.reasoningContent) {
        const block = this.#blockOf(contentBlockIndex, "reasoning");
        if (block?.kind !== "reasoning") return;
        const r = delta.reasoningContent;
        if (r.text !== undefined) block.text += r.text;
        if (r.signature !== undefined) block.signature += r.signature;
        if (r.redactedContent !== undefined) block.redacted.push(r.redactedContent);
      } else if (delta?.toolUse) {
        const block = this.#blocks.get(contentBlockIndex);
        if (block?.kind === "tool_use") block.json += delta.toolUse.input ?? "";
      }
    } else if (event.contentBlockStop) {
      const block = this.#blocks.get(event.contentBlockStop.contentBlockIndex ?? 0);
      if (block?.kind === "text") this.#emit(block, block.filter.end());
    } else if (event.messageStop) {
      this.#rawStop = event.messageStop.stopReason;
    } else if (event.metadata?.usage) {
      const u = event.metadata.usage;
      this.#usage = {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadInputTokens ?? 0,
        cacheWriteTokens: u.cacheWriteInputTokens ?? 0,
      };
    }
  }

  finish(): LlmResponse {
    let stopReason = toLlmStopReason(this.#rawStop);
    const content: ContentBlock[] = [];
    const tag = { family: this.#request.family, modelId: this.#request.modelId };
    for (const [, block] of [...this.#blocks].sort(([a], [b]) => a - b)) {
      if (block.kind === "text") {
        // Only a profile that declares a tag keeps the removed text, as an unsigned reasoning block. For
        // the others (Claude) it is dropped: Claude rejects a reasoning block without its signature on replay.
        const reasoning = block.filter.reasoning;
        if (reasoning && this.#request.inlineReasoningTag)
          content.push({ type: "reasoning", ...tag, text: reasoning });
        if (block.text.length > 0) content.push({ type: "text", text: block.text });
      } else if (block.kind === "reasoning") {
        if (block.redacted.length > 0) {
          content.push({
            type: "reasoning",
            ...tag,
            redactedContent: Buffer.concat(block.redacted).toString("base64"),
          });
        } else if (block.text.length > 0 || block.signature.length > 0) {
          content.push({
            type: "reasoning",
            ...tag,
            text: block.text,
            ...(block.signature.length > 0 ? { signature: block.signature } : {}),
          });
        }
      } else {
        const input = parseToolInput(block.json);
        // A tool call whose input isn't JSON can't run. Truncation (max_tokens) is handled by the caller.
        if (input === INVALID && stopReason === "tool_use") stopReason = "malformed_output";
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: input === INVALID ? {} : input,
        });
      }
    }
    return { content, stopReason, providerStopReason: this.#rawStop ?? "unknown", usage: this.#usage };
  }

  #open(index: number, block: BlockState): BlockState {
    this.#blocks.set(index, block);
    const type: ContentBlockType = block.kind === "tool_use" ? "tool_use" : block.kind;
    this.#handlers.onContentBlockStart?.({ type });
    return block;
  }

  /** The block at `index`, opened as `kind` on its first delta (text and reasoning blocks have no start event). */
  #blockOf(index: number, kind: "text" | "reasoning"): BlockState | undefined {
    const existing = this.#blocks.get(index);
    if (existing) return existing;
    if (kind === "reasoning") return this.#open(index, { kind, text: "", signature: "", redacted: [] });
    const tags = new Set([ALWAYS_STRIPPED_TAG, this.#request.inlineReasoningTag ?? ALWAYS_STRIPPED_TAG]);
    return this.#open(index, { kind, text: "", filter: new InlineReasoningFilter([...tags]) });
  }

  #text(index: number, text: string): void {
    const block = this.#blockOf(index, "text");
    if (block?.kind !== "text") return;
    this.#emit(block, block.filter.push(text));
  }

  #emit(block: { text: string }, visible: string): void {
    if (visible.length === 0) return;
    block.text += visible;
    this.#handlers.onTextDelta?.(visible);
  }
}

const INVALID = Symbol("invalid");

function parseToolInput(json: string): unknown {
  if (json.trim().length === 0) return {};
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return INVALID;
  }
}

/** Stripped from every profile's visible text, whatever its own tag (#107): Nova Pro leaks it even when told not to. */
export const ALWAYS_STRIPPED_TAG = "thinking";

/**
 * Removes inline chain-of-thought sections from a text block while it streams (#107).
 *
 * The rule:
 * - A section is an opening tag for one of `tags` up to its closing tag, anywhere in the block. A tag
 *   matches the way the `no_reasoning_leak` grader's `REASONING_TAG` does: any case, optional whitespace
 *   and a slash, and attributes (`<Thinking>`, `< thinking type="plan">`, `</thinking >`).
 * - An opening tag that is never closed hides the rest of its text block. Later blocks have their own filter.
 * - A closing tag with no opener is removed on its own.
 * - Whitespace before and after a section is dropped while nothing visible has been shown yet, so a
 *   reply that starts with a section doesn't start with blank lines. Elsewhere it is kept.
 * - Text is held back only while it could still become a tag (a `<` with a partial tag name after it,
 *   or a full tag name whose `>` hasn't arrived), including a tag split across deltas. At the end of the
 *   block, held-back text that never became a tag is shown.
 *
 * The removed sections are joined in `reasoning`; the caller decides whether to keep them. The visible
 * part is exactly what's streamed, so the stored text always matches what the patient saw.
 */
export class InlineReasoningFilter {
  readonly #names: readonly string[];
  readonly #tagAtStart: RegExp;
  #inside: RegExp | undefined;
  #buffer = "";
  #shown = false;
  #removed = false;
  #sections: string[] = [];

  /** `tags`: the tag names to remove (word characters only), matched case-insensitively. */
  constructor(tags: readonly string[]) {
    this.#names = tags.map((t) => t.toLowerCase());
    this.#tagAtStart = new RegExp(`^<\\s*(\\/?)\\s*(${this.#names.join("|")})\\b[^>]*>`, "i");
  }

  /** The removed sections, trimmed and joined by a blank line. */
  get reasoning(): string {
    return this.#sections.join("\n\n");
  }

  /** Feed a delta; returns the text to show now. */
  push(delta: string): string {
    this.#buffer += delta;
    return this.#drain();
  }

  /** The block ended; returns any held-back text to show. */
  end(): string {
    if (this.#inside) {
      this.#section(this.#buffer); // never closed: all of it was reasoning
      this.#buffer = "";
      return "";
    }
    const rest = this.#buffer;
    this.#buffer = "";
    return this.#show(rest);
  }

  #drain(): string {
    let out = "";
    for (;;) {
      if (this.#inside) {
        const close = this.#inside.exec(this.#buffer);
        if (!close) return out;
        this.#section(this.#buffer.slice(0, close.index));
        this.#buffer = this.#buffer.slice(close.index + close[0].length);
        this.#inside = undefined;
        continue;
      }
      const lt = this.#buffer.indexOf("<");
      const before = lt === -1 ? this.#buffer : this.#buffer.slice(0, lt);
      // Leading whitespace is held until we know whether a section follows it.
      if (this.#shown || before.trim().length > 0) {
        out += this.#show(before);
        this.#buffer = this.#buffer.slice(before.length);
      }
      if (lt === -1) return out;
      const at = this.#buffer.indexOf("<");
      const rest = this.#buffer.slice(at);
      const tag = this.#tagAtStart.exec(rest);
      if (tag) {
        const [whole, slash, name = ""] = tag;
        if (slash === "") this.#inside = new RegExp(`<\\s*\\/\\s*${name}\\b[^>]*>`, "i");
        this.#removed = true;
        this.#buffer = rest.slice(whole.length);
        continue;
      }
      if (this.#couldBeTag(rest)) return out;
      out += this.#show(this.#buffer.slice(0, at + 1));
      this.#buffer = this.#buffer.slice(at + 1);
    }
  }

  /** `text` starts with `<` and isn't one of our tags yet: could more input make it one? */
  #couldBeTag(text: string): boolean {
    const [, word = "", after = ""] = /^<\s*\/?\s*(\w*)([\s\S]*)$/.exec(text) ?? [];
    const lower = word.toLowerCase();
    if (after === "") return this.#names.some((name) => name.startsWith(lower));
    return this.#names.includes(lower); // the full name, then attributes whose `>` hasn't arrived
  }

  #section(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length > 0) this.#sections.push(trimmed);
  }

  #show(text: string): string {
    const visible = !this.#shown && this.#removed ? text.trimStart() : text;
    this.#shown = true;
    return visible;
  }
}
