/**
 * The agent loop (ADR-001): our own tool-use loop over the provider-neutral `LlmClient` (ADR-010).
 *
 * One call to `runAgentTurn` handles one patient message: it calls the model, runs the tools it asks
 * for (concurrently), feeds the results back, and repeats until the model answers or a limit is hit.
 * It streams `status`, `text_delta`, and `text_reset` events as it goes and returns the messages to
 * append to history, a trace of every model and tool call, and the aggregated token usage.
 *
 * Invariants:
 * - Append-only: `history` is never modified. Assistant content (reasoning blocks included) is stored
 *   exactly as the client returned it. A response that gets retried (refusal, `max_tokens`, malformed
 *   output) is discarded, never stored, so `newMessages` is always a valid continuation of `history`.
 *   If its text already streamed, a `text_reset` tells the client to drop it.
 * - Reasoning blocks are sent back only to a model of the same family that accepts them; they're
 *   filtered out of the request copy otherwise, never out of history.
 * - The loop never sees a patient ID. The executor was bound to the patient by the caller.
 * - Bounded: at most `limits.maxIterations` model calls per turn, retries included.
 * - Tool failures never throw out of the loop; they become `is_error` tool results.
 * - The loop never emits `done` or `error`. Those belong to the chat handler, which has the persisted
 *   message ID and maps `outcome` (and any thrown setup error) to the terminal event (ADR-007).
 */
import {
  type ChatStreamEvent,
  type ContentBlock,
  type ConversationId,
  type LlmCallTrace,
  TOOL_STATUS_LABELS,
  TRACE_TOOL_NAME_MAX,
  type TokenUsage,
  type ToolCallTrace,
  type ToolError,
  type ToolErrorCode,
  type ToolName,
  type ToolResultBlock,
  type ToolUseBlock,
  type TurnId,
  type TurnOutcome,
  type TurnTrace,
} from "@sched/contracts";

import { FALLBACK_MESSAGES } from "./fallback-messages";
import {
  CACHE_POINT,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
  type LlmRequestMessage,
  type LlmResponse,
  type LlmStreamHandlers,
} from "./llm/types";
import { profileRequest, type RequestSystem } from "./llm/request";
import type { Clock, ToolExecutionResult, ToolExecutor } from "./ports";
import { fallbackProfileFor, type ModelProfile } from "./profiles";
import { addUsage, zeroUsage } from "./usage";

/** The system prompt, split for prompt caching (`RequestSystem`). The real prompt comes from `prompts/` (#16). */
export interface SystemPrompt extends RequestSystem {
  /** Recorded in the trace as `promptVersion`, e.g. `"system.v1"`. */
  version: string;
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
  history: readonly LlmMessage[];
  /** The patient's new message. */
  userMessage: string;
  system: SystemPrompt;
  /** Tools, pre-bound to the authenticated patient. */
  executor: ToolExecutor;
  llm: LlmClient;
  profile: ModelProfile;
  clock: Clock;
  limits?: Partial<AgentLimits>;
  /** Stream sink for `status`, `text_delta`, and `text_reset` events. Called synchronously, in order. */
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
  newMessages: LlmMessage[];
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

export function runAgentTurn(input: RunAgentTurnInput): Promise<AgentTurnResult> {
  return new AgentTurn(input).run();
}

// ---------------------------------------------------------------------------------------------

type ToolUse = ToolUseBlock;
type FinishOutcome =
  "iteration_limit" | "max_tokens" | "refusal" | "context_window_exceeded" | "malformed_output";

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
  readonly #offered: ReadonlySet<string>;

  readonly #newMessages: LlmMessage[];
  readonly #llmCalls: LlmCallTrace[] = [];
  readonly #toolCalls: ToolCallTrace[] = [];
  #usage: TokenUsage = zeroUsage();
  #error: unknown;

  #profile: ModelProfile;
  #maxTokens: number;
  #retriedMaxTokens = false;
  #retriedMalformed = false;
  #fellBack = false;
  #toolCallsRun = 0;
  /** Retries so far of the current step (0 after a response is kept). */
  #attempt = 0;
  /** Characters streamed this turn, and how many of them belong to kept responses. */
  #streamedChars = 0;
  #keptChars = 0;

  constructor(input: RunAgentTurnInput) {
    this.#in = input;
    this.#limits = { ...DEFAULT_LIMITS, ...input.limits };
    this.#monotonic = input.monotonicNow ?? (() => performance.now());
    this.#emit = input.onEvent ?? (() => undefined);
    this.#offered = new Set(input.executor.definitions.map((d) => d.name));
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

      const response = await this.#callModel();
      if (response === undefined) return "error";

      switch (response.stopReason) {
        case "tool_use": {
          const toolUses = response.content.filter((b): b is ToolUse => b.type === "tool_use");
          if (toolUses.length === 0) {
            this.#appendAssistant(response);
            return "completed";
          }
          // Don't start side effects (a booking) for a request that's being torn down. Discarding the
          // response keeps history valid: no tool_use without its tool_result.
          if (this.#in.signal?.aborted) {
            this.#error = this.#in.signal.reason;
            return "error";
          }
          this.#appendAssistant(response);
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
          this.#discard();
          if (!this.#retriedMaxTokens) {
            this.#retriedMaxTokens = true;
            this.#maxTokens = this.#profile.retryMaxTokens;
            continue;
          }
          return this.#finishWith("max_tokens");

        case "context_window_exceeded":
          this.#discard();
          return this.#finishWith("context_window_exceeded");

        case "refusal":
          // Bedrock has no server-side fallbacks, so retry once on the fallback profile (ADR-002), and stay
          // on it for the rest of the turn.
          this.#discard();
          if (!this.#fellBack) {
            this.#fellBack = true;
            this.#profile = fallbackProfileFor(this.#profile);
            this.#maxTokens = this.#retriedMaxTokens ? this.#profile.retryMaxTokens : this.#profile.maxTokens;
            continue;
          }
          return this.#finishWith("refusal");

        case "malformed_output":
          // A malformed tool call can't run and can't be stored (it has no valid result). Retry once as-is.
          this.#discard();
          if (!this.#retriedMalformed) {
            this.#retriedMalformed = true;
            continue;
          }
          return this.#finishWith("malformed_output");

        default: // end_turn, stop_sequence
          this.#appendAssistant(response);
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

  async #callModel(): Promise<LlmResponse | undefined> {
    const profile = this.#profile;
    const request: LlmRequest = {
      ...profileRequest(profile, this.#in.system, { maxTokens: this.#maxTokens }),
      tools: this.#in.executor.definitions,
      messages: requestMessages([...this.#in.history, ...this.#newMessages], profile),
    };
    const index = this.#llmCalls.length;
    const attempt = this.#attempt;
    const startedAt = this.#in.clock.now().toISOString();
    const t0 = this.#monotonic();
    let ttftMs: number | undefined;
    const handlers = this.#streamHandlers(() => {
      ttftMs ??= this.#elapsed(t0);
    });
    const base = { index, attempt, modelId: profile.modelId, startedAt };

    try {
      const response = await this.#in.llm.streamMessage(request, handlers, { signal: this.#in.signal });
      this.#usage = addUsage(this.#usage, response.usage);
      this.#llmCalls.push({
        ...base,
        durationMs: this.#elapsed(t0),
        ...(ttftMs === undefined ? {} : { ttftMs }),
        stopReason: response.stopReason,
        ...(response.providerStopReason !== response.stopReason
          ? { providerStopReason: response.providerStopReason }
          : {}),
        usage: response.usage,
      });
      return response;
    } catch (error) {
      this.#llmCalls.push({
        ...base,
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
        if (block.type === "text") separatorPending = this.#streamedChars > 0;
      },
      onTextDelta: (text) => {
        if (text.length === 0) return;
        if (separatorPending) {
          separatorPending = false;
          this.#stream(TEXT_BLOCK_SEPARATOR);
        }
        this.#stream(text);
      },
    };
  }

  #stream(text: string): void {
    this.#emit({ type: "text_delta", text });
    this.#streamedChars += text.length;
  }

  /** The last response won't be kept: take back any text it streamed, and count the retry. */
  #discard(): void {
    this.#attempt += 1;
    if (this.#streamedChars > this.#keptChars) {
      this.#emit({ type: "text_reset", keepChars: this.#keptChars });
      this.#streamedChars = this.#keptChars;
    }
  }

  /** The last response is kept: what it streamed is now part of the stored text. */
  #keep(): void {
    this.#attempt = 0;
    this.#keptChars = this.#streamedChars;
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

  #appendAssistant(response: LlmResponse): void {
    this.#keep();
    // An empty assistant message is invalid in history, so a reply with nothing visible or callable
    // (no text, no tool call; reasoning alone) isn't stored.
    if (!response.content.some((b) => b.type === "text" || b.type === "tool_use")) return;
    this.#newMessages.push({ role: "assistant", content: response.content });
  }

  /**
   * All results go back in ONE user message, in the model's order (parallel tool use). Every call is
   * traced; one naming a tool we never offered is traced with `known: false`.
   */
  #appendToolResults(runs: ToolRun[]): void {
    const content = runs.map(({ use, result, durationMs }): ToolResultBlock => {
      this.#toolCalls.push({
        toolUseId: use.id,
        name: use.name.slice(0, TRACE_TOOL_NAME_MAX),
        known: this.#isOffered(use.name),
        input: structuredClone(use.input),
        ok: result.ok,
        ...(result.ok ? {} : { errorCode: result.error.error.code }),
        durationMs,
      });
      return result.ok
        ? { type: "tool_result", toolUseId: use.id, content: JSON.stringify(result.output ?? null) }
        : { type: "tool_result", toolUseId: use.id, content: JSON.stringify(result.error), isError: true };
    });
    this.#newMessages.push({ role: "user", content });
  }

  /** Stream and store a fixed reply, and return the outcome it stands for. */
  #finishWith(outcome: FinishOutcome): TurnOutcome {
    const text = {
      iteration_limit: FALLBACK_MESSAGES.iterationLimit,
      max_tokens: FALLBACK_MESSAGES.maxTokens,
      context_window_exceeded: FALLBACK_MESSAGES.contextWindow,
      refusal: FALLBACK_MESSAGES.refusal,
      malformed_output: FALLBACK_MESSAGES.malformedOutput,
    }[outcome];
    if (this.#streamedChars > 0) this.#stream(TEXT_BLOCK_SEPARATOR);
    this.#stream(text);
    this.#keptChars = this.#streamedChars;
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

/**
 * The request's copy of the conversation:
 * - reasoning blocks the target model can't take (another family, or a model that rejects them) are
 *   left out;
 * - a rolling cache point goes at the end of the final user message, so the next call (the next
 *   iteration or the next turn) reads the conversation so far from cache.
 * Stored messages are never changed.
 */
function requestMessages(messages: readonly LlmMessage[], profile: ModelProfile): LlmRequestMessage[] {
  const keep = (block: ContentBlock) =>
    block.type !== "reasoning" || (profile.replaysReasoning && block.family === profile.family);
  const copy: LlmRequestMessage[] = messages.map((m) => ({ role: m.role, content: m.content.filter(keep) }));
  const last = copy.at(-1);
  if (profile.cachePoints.messages && last?.role === "user") last.content = [...last.content, CACHE_POINT];
  return copy;
}

function storedText(messages: LlmMessage[]): string {
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
    .filter((text) => text.length > 0)
    .join(TEXT_BLOCK_SEPARATOR);
}
