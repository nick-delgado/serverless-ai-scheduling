/**
 * The agent loop (ADR-001): our own tool-use loop over the Messages API.
 *
 * One call to `runAgentTurn` handles one patient message: it calls the model, runs the tools it asks
 * for (concurrently), feeds the results back, and repeats until the model answers or a limit is hit.
 * It streams `status` and `text_delta` events as it goes and returns the messages to append to history,
 * a trace of every model and tool call, and the aggregated token usage.
 *
 * Invariants:
 * - Append-only: `history` is never modified. Assistant content (thinking blocks included) is stored
 *   exactly as the model returned it. A response that gets retried (refusal, `max_tokens`) is discarded,
 *   never stored, so `newMessages` is always a valid continuation of `history`.
 * - The loop never sees a patient ID. The executor was bound to the patient by the caller.
 * - Bounded: at most `limits.maxIterations` model calls per turn, retries included.
 * - Tool failures never throw out of the loop; they become `is_error` tool results.
 * - The loop never emits `done` or `error`. Those belong to the chat handler, which has the persisted
 *   message ID and maps `outcome` (and any thrown setup error) to the terminal event (ADR-007).
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  type ChatStreamEvent,
  type ConversationId,
  type LlmCallTrace,
  type ModelToolDefinition,
  TOOL_STATUS_LABELS,
  type TokenUsage,
  type ToolCallTrace,
  type ToolError,
  type ToolErrorCode,
  type ToolName,
  type TurnId,
  type TurnOutcome,
  type TurnTrace,
} from "@sched/contracts";

import { FALLBACK_MESSAGES } from "./fallback-messages";
import type { LlmClient, LlmRequest, LlmStreamHandlers } from "./llm/client";
import type { Clock, ToolExecutionResult, ToolExecutor } from "./ports";
import { fallbackProfileFor, type ModelProfile } from "./profiles";

/** The system prompt, split for prompt caching. The real prompt comes from `prompts/` (#16). */
export interface SystemPrompt {
  /** Recorded in the trace as `promptVersion`, e.g. `"system.v1"`. */
  version: string;
  /** Byte-identical on every request. The cache breakpoint goes on this block (after the tools). */
  stable: string;
  /** Volatile context rendered after the breakpoint: today's date, timezone, patient first name. */
  dynamic?: string;
}

export interface AgentLimits {
  /** Model calls per turn, retries included (ADR-001: 8). When hit, the patient gets an apology and an escalation offer. */
  maxIterations: number;
  /** Tool calls executed per turn. Calls beyond it get a `NOT_ALLOWED` error result instead of running. */
  maxToolCallsPerTurn: number;
}

export const DEFAULT_LIMITS: Readonly<AgentLimits> = { maxIterations: 8, maxToolCallsPerTurn: 16 };

export interface RunAgentTurnInput {
  /** Prior messages from storage, oldest first. Never modified. */
  history: readonly Anthropic.MessageParam[];
  /** The patient's new message. */
  userMessage: string;
  system: SystemPrompt;
  /** Tools, pre-bound to the authenticated patient. */
  executor: ToolExecutor;
  llm: LlmClient;
  profile: ModelProfile;
  clock: Clock;
  limits?: Partial<AgentLimits>;
  /** Stream sink for `status` and `text_delta` events. Called synchronously, in order. */
  onEvent?: (event: ChatStreamEvent) => void;
  conversationId: ConversationId;
  turnId: TurnId;
  /** Aborts in-flight model calls; tools that haven't started are not run. */
  signal?: AbortSignal;
  /** Monotonic milliseconds for durations and TTFT. Default `performance.now`. */
  monotonicNow?: () => number;
}

export interface AgentTurnResult {
  /** Messages to append to history: the user message first, then this turn's assistant/tool messages. */
  newMessages: Anthropic.MessageParam[];
  trace: TurnTrace;
  /** Summed over every model call in the turn, including discarded ones (they're billed too). */
  usage: TokenUsage;
  outcome: TurnOutcome;
  /** The assistant text this turn stored, text blocks joined by a blank line (what the patient saw). */
  text: string;
  /** Why the turn failed when `outcome` is `"error"` (a model call threw or the signal aborted). */
  error?: unknown;
}

/** Streamed between separate text blocks so a preamble and the answer don't run together. */
export const TEXT_BLOCK_SEPARATOR = "\n\n";

const EPHEMERAL = { type: "ephemeral" } as const;

export function runAgentTurn(input: RunAgentTurnInput): Promise<AgentTurnResult> {
  return new AgentTurn(input).run();
}

// ---------------------------------------------------------------------------------------------

type ToolUse = Anthropic.ToolUseBlock;

/** One tool_use block and how it was answered. */
interface ToolRun {
  use: ToolUse;
  result: ToolExecutionResult;
  /** 0 when the call was answered without running. */
  durationMs: number;
}

class AgentTurn {
  readonly #in: RunAgentTurnInput;
  readonly #limits: AgentLimits;
  readonly #monotonic: () => number;
  readonly #emit: (event: ChatStreamEvent) => void;
  readonly #tools: Anthropic.Tool[];
  readonly #offered: ReadonlySet<string>;
  readonly #system: Anthropic.TextBlockParam[];

  readonly #newMessages: Anthropic.MessageParam[];
  readonly #llmCalls: LlmCallTrace[] = [];
  readonly #toolCalls: ToolCallTrace[] = [];
  #usage: TokenUsage = zeroUsage();
  #error: unknown;

  #profile: ModelProfile;
  #maxTokens: number;
  #retriedMaxTokens = false;
  #fellBack = false;
  #toolCallsRun = 0;
  #textEmitted = false;

  constructor(input: RunAgentTurnInput) {
    this.#in = input;
    this.#limits = { ...DEFAULT_LIMITS, ...input.limits };
    this.#monotonic = input.monotonicNow ?? (() => performance.now());
    this.#emit = input.onEvent ?? (() => undefined);
    this.#tools = input.executor.definitions.map(toSdkTool);
    this.#offered = new Set(input.executor.definitions.map((d) => d.name));
    this.#system = systemBlocks(input.system);
    this.#newMessages = [{ role: "user", content: [{ type: "text", text: input.userMessage }] }];
    this.#profile = input.profile;
    this.#maxTokens = input.profile.maxTokens;
  }

  async run(): Promise<AgentTurnResult> {
    const startedAt = this.#in.clock.now().toISOString();
    const t0 = this.#monotonic();
    const outcome = await this.#loop();
    const trace: TurnTrace = {
      turnId: this.#in.turnId,
      conversationId: this.#in.conversationId,
      modelProfile: this.#in.profile.name,
      modelId: this.#in.profile.modelId,
      promptVersion: this.#in.system.version,
      startedAt,
      durationMs: this.#elapsed(t0),
      iterations: this.#llmCalls.length,
      llmCalls: this.#llmCalls,
      toolCalls: this.#toolCalls,
      usage: this.#usage,
      outcome,
    };
    return {
      newMessages: this.#newMessages,
      trace,
      usage: this.#usage,
      outcome,
      text: storedText(this.#newMessages),
      ...(outcome === "error" ? { error: this.#error } : {}),
    };
  }

  async #loop(): Promise<TurnOutcome> {
    for (;;) {
      if (!this.#canCallModel()) return this.#finishWith("iteration_limit");

      const message = await this.#callModel();
      if (message === undefined) return "error";

      switch (message.stop_reason) {
        case "tool_use": {
          const toolUses = message.content.filter((b): b is ToolUse => b.type === "tool_use");
          if (toolUses.length === 0) {
            this.#appendAssistant(message);
            return "completed";
          }
          // Don't start side effects (a booking) for a request that's being torn down. Discarding the
          // response keeps history valid: no tool_use without its tool_result.
          if (this.#in.signal?.aborted) {
            this.#error = this.#in.signal.reason;
            return "error";
          }
          this.#appendAssistant(message);
          if (!this.#canCallModel()) {
            // No model call left to read the results, so don't run anything the patient won't hear about.
            this.#appendToolResults(toolUses.map((use) => notRun(use, ITERATION_LIMIT_ERROR)));
            return this.#finishWith("iteration_limit");
          }
          this.#appendToolResults(await this.#runTools(toolUses));
          continue;
        }

        case "max_tokens":
          // Truncated output (possibly a half-written tool input) is discarded, never run or stored.
          if (!this.#retriedMaxTokens) {
            this.#retriedMaxTokens = true;
            this.#maxTokens = this.#profile.retryMaxTokens;
            continue;
          }
          return this.#finishWith("max_tokens");

        case "model_context_window_exceeded":
          return this.#finishWith("max_tokens");

        case "refusal":
          // Bedrock has no server-side fallbacks, so retry once on the fallback profile (ADR-002), and stay
          // on it for the rest of the turn.
          if (!this.#fellBack) {
            this.#fellBack = true;
            this.#profile = fallbackProfileFor(this.#profile);
            this.#maxTokens = this.#retriedMaxTokens ? this.#profile.retryMaxTokens : this.#profile.maxTokens;
            continue;
          }
          return this.#finishWith("refusal");

        case "pause_turn":
          // Only server tools pause, and we have none; if it happens anyway, continue as the API documents.
          this.#appendAssistant(message);
          continue;

        default: // end_turn, stop_sequence
          this.#appendAssistant(message);
          return "completed";
      }
    }
  }

  #canCallModel(): boolean {
    return this.#llmCalls.length < this.#limits.maxIterations;
  }

  // -------------------------------------------------------------------------------------------
  // Model calls
  // -------------------------------------------------------------------------------------------

  async #callModel(): Promise<Anthropic.Message | undefined> {
    const profile = this.#profile;
    const request: LlmRequest = {
      ...profile.params,
      model: profile.modelId,
      max_tokens: this.#maxTokens,
      tools: this.#tools,
      system: this.#system,
      messages: withConversationBreakpoint([...this.#in.history, ...this.#newMessages]),
    };
    const index = this.#llmCalls.length;
    const startedAt = this.#in.clock.now().toISOString();
    const t0 = this.#monotonic();
    let ttftMs: number | undefined;
    const handlers = this.#streamHandlers(() => {
      ttftMs ??= this.#elapsed(t0);
    });

    try {
      const message = await this.#in.llm.streamMessage(request, handlers, { signal: this.#in.signal });
      const usage = toTokenUsage(message.usage);
      this.#usage = addUsage(this.#usage, usage);
      this.#llmCalls.push({
        index,
        modelId: profile.modelId,
        startedAt,
        durationMs: this.#elapsed(t0),
        ...(ttftMs === undefined ? {} : { ttftMs }),
        stopReason: message.stop_reason ?? "unknown",
        usage,
      });
      return message;
    } catch (error) {
      this.#llmCalls.push({
        index,
        modelId: profile.modelId,
        startedAt,
        durationMs: this.#elapsed(t0),
        ...(ttftMs === undefined ? {} : { ttftMs }),
        stopReason: "error",
        usage: zeroUsage(),
      });
      this.#error = error;
      return undefined;
    }
  }

  #streamHandlers(onFirstBlock: () => void): LlmStreamHandlers {
    let separatorPending = false;
    return {
      onContentBlockStart: (block) => {
        onFirstBlock();
        if (block.type === "text") separatorPending = this.#textEmitted;
      },
      onTextDelta: (text) => {
        if (text.length === 0) return;
        if (separatorPending) {
          separatorPending = false;
          this.#emit({ type: "text_delta", text: TEXT_BLOCK_SEPARATOR });
        }
        this.#emit({ type: "text_delta", text });
        this.#textEmitted = true;
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------------------------

  async #runTools(toolUses: ToolUse[]): Promise<ToolRun[]> {
    // Decide every call up front, in order, so limits apply deterministically; then run the allowed ones
    // concurrently. Results keep the model's order.
    const plan = toolUses.map((use): { use: ToolUse; name?: ToolName; skip?: ToolRun } => {
      if (!this.#isOffered(use.name)) return { use, skip: notRun(use, unknownToolError(use.name)) };
      if (this.#toolCallsRun >= this.#limits.maxToolCallsPerTurn)
        return { use, skip: notRun(use, TOOL_LIMIT_ERROR) };
      this.#toolCallsRun += 1;
      return { use, name: use.name };
    });

    for (const { name } of plan) {
      if (name !== undefined) this.#emit({ type: "status", tool: name, label: TOOL_STATUS_LABELS[name] });
    }
    return Promise.all(plan.map(({ use, skip }) => skip ?? this.#execute(use)));
  }

  async #execute(use: ToolUse): Promise<ToolRun> {
    const t0 = this.#monotonic();
    let result: ToolExecutionResult;
    try {
      // A copy, so an executor that mutates its input can't reach the stored assistant message.
      result = await this.#in.executor.execute({
        id: use.id,
        name: use.name,
        input: structuredClone(use.input),
      });
    } catch {
      // Contract breach: executors return `{ ok: false }` and log their own failures. The raw error stays
      // out of the model's context (it may carry internals); the trace records INTERNAL.
      result = fail(INTERNAL_TOOL_ERROR);
    }
    return { use, result, durationMs: this.#elapsed(t0) };
  }

  #isOffered(name: string): name is ToolName {
    return this.#offered.has(name);
  }

  // -------------------------------------------------------------------------------------------
  // History, trace, and fixed replies
  // -------------------------------------------------------------------------------------------

  #appendAssistant(message: Anthropic.Message): void {
    // The API rejects an empty assistant message in history, so an empty reply isn't stored.
    if (message.content.length === 0) return;
    this.#newMessages.push({ role: "assistant", content: message.content });
  }

  /**
   * All results go back in ONE user message, in the model's order (parallel tool use). Every call is
   * traced, except one naming a tool we never offered: the trace schema only admits real tool names.
   */
  #appendToolResults(runs: ToolRun[]): void {
    const content = runs.map(({ use, result, durationMs }): Anthropic.ToolResultBlockParam => {
      if (this.#isOffered(use.name)) {
        this.#toolCalls.push({
          toolUseId: use.id,
          name: use.name,
          input: structuredClone(use.input),
          ok: result.ok,
          ...(result.ok ? {} : { errorCode: result.error.error.code }),
          durationMs,
        });
      }
      return result.ok
        ? { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result.output ?? null) }
        : { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result.error), is_error: true };
    });
    this.#newMessages.push({ role: "user", content });
  }

  /** Stream and store a fixed reply, and return the outcome it stands for. */
  #finishWith(outcome: "iteration_limit" | "max_tokens" | "refusal"): TurnOutcome {
    const text = {
      iteration_limit: FALLBACK_MESSAGES.iterationLimit,
      max_tokens: FALLBACK_MESSAGES.maxTokens,
      refusal: FALLBACK_MESSAGES.refusal,
    }[outcome];
    if (this.#textEmitted) this.#emit({ type: "text_delta", text: TEXT_BLOCK_SEPARATOR });
    this.#emit({ type: "text_delta", text });
    this.#textEmitted = true;
    this.#newMessages.push({ role: "assistant", content: [{ type: "text", text }] });
    return outcome;
  }

  #elapsed(t0: number): number {
    return Math.max(0, Math.round(this.#monotonic() - t0));
  }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

const toolError = (code: ToolErrorCode, message: string, hint?: string): ToolError => ({
  error: { code, message, ...(hint === undefined ? {} : { hint }) },
});

const fail = (error: ToolError): ToolExecutionResult => ({ ok: false, error });

/** A call answered with an error result without running. */
const notRun = (use: ToolUse, error: ToolError): ToolRun => ({ use, result: fail(error), durationMs: 0 });

const unknownToolError = (name: string): ToolError =>
  toolError(
    "NOT_FOUND",
    `There is no tool named "${name.slice(0, 60)}".`,
    "Use only the tools you were given.",
  );

const TOOL_LIMIT_ERROR = toolError(
  "NOT_ALLOWED",
  "Not run: this turn reached its tool-call limit.",
  "Answer with what you have, or offer to connect the patient with the front desk.",
);

const ITERATION_LIMIT_ERROR = toolError("NOT_ALLOWED", "Not run: this turn reached its step limit.");

const INTERNAL_TOOL_ERROR = toolError(
  "INTERNAL",
  "The tool failed unexpectedly.",
  "Apologize, and offer to try again or to connect the patient with the front desk.",
);

function toSdkTool(definition: ModelToolDefinition): Anthropic.Tool {
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.input_schema,
  };
}

/** Tools render first, then system: a breakpoint on the stable block caches tools + stable system together. */
function systemBlocks(prompt: SystemPrompt): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: prompt.stable, cache_control: EPHEMERAL },
  ];
  if (prompt.dynamic) blocks.push({ type: "text", text: prompt.dynamic });
  return blocks;
}

/**
 * A second, rolling breakpoint on the last block of the request's final user message, so the next call
 * (the next iteration or the next turn) reads the conversation so far from cache. It's added to a copy:
 * stored messages never carry `cache_control`.
 */
function withConversationBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages.at(-1);
  if (last?.role !== "user") return messages;
  const content: Anthropic.ContentBlockParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  const lastBlock = content.at(-1);
  if (lastBlock?.type !== "text" && lastBlock?.type !== "tool_result") return messages;
  return [
    ...messages.slice(0, -1),
    { ...last, content: [...content.slice(0, -1), { ...lastBlock, cache_control: EPHEMERAL }] },
  ];
}

function storedText(messages: Anthropic.MessageParam[]): string {
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) =>
      typeof m.content === "string" ? [m.content] : m.content.map((b) => (b.type === "text" ? b.text : "")),
    )
    .filter((text) => text.length > 0)
    .join(TEXT_BLOCK_SEPARATOR);
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function toTokenUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
