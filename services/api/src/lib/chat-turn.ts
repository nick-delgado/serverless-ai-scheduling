/**
 * The chat turn core behind `POST /api/chat` (S3-03, #17): one patient message in, an NDJSON event
 * stream out. Transport-free, with every dependency injected (CLAUDE.md rule 3), so the Lambda
 * (`handlers/chat.ts`), the integration tests and the eval harness (in-process, #30) run the same code.
 *
 * Order of work, and why:
 * 1. Identity comes from the verified JWT `sub` only (`patientId` here). Bad body → 400. Nothing is
 *    counted or stored for a request that never reaches the agent.
 * 2. The daily turn cap (ADR-009) is consumed atomically before any model call.
 * 3. History is loaded ONLY through the owned read `listMessages(patientId, conversationId)`. A body
 *    `conversationId` that reads as empty (unknown, expired, or another patient's: they look the same)
 *    is never used: the turn starts a new conversation with a server-generated ID (ADR-004 amendment).
 * 4. The patient's message is stored BEFORE the agent loop runs, so an escalation's staff transcript
 *    (read from storage, #23) includes it, and a failed turn never loses it (FR-015).
 * 5. `runAgentTurn` streams `status`, `text_delta` and `text_reset` straight through. The tool executor
 *    is bound to this patient and to the conversation whose history was just loaded.
 * 6. The turn's messages are appended verbatim (reasoning blocks included), then the trace.
 * 7. This module owns the terminal event: `done` (with the stored reply's message ID) or `error`. The
 *    stream always ends, whatever throws.
 */
import { randomUUID } from "node:crypto";

import {
  runAgentTurn,
  type AgentLimits,
  type AgentTurnResult,
  type Clock,
  type LlmClient,
  type LlmMessage,
  type ModelProfile,
} from "@sched/agent";
import {
  ChatRequest,
  PatientId,
  TOOL_NAMES,
  messageIdForSeq,
  type ConversationId,
  type ConversationMessage,
  type TurnId,
} from "@sched/contracts";
import {
  ConversationAppendError,
  MAX_APPEND_BATCH,
  TOOL_REGISTRY,
  clinicDateOf,
  createToolExecutor,
  type Notifier,
  type Repositories,
  type ToolRegistry,
} from "@sched/tools";

import { FAILURES, classifyAgentError, type ChatFailure } from "./errors";
import { closingReply, needsClosingReply, toLlmHistory, toStoredMessages } from "./history";
import { errorSummary, silentLogger, type Logger } from "./log";
import { parseJsonBody } from "./request";
import { EventWriter, type EventSink } from "./stream";
import type { SystemPromptFactory } from "./system-prompt";
import type { TurnStore } from "./turn-store";

/** ADR-009's example cap: 50 agent turns per patient per clinic-local day. */
export const DEFAULT_DAILY_TURN_CAP = 50;

export interface ChatTurnDeps {
  repos: Repositories;
  turns: TurnStore;
  llm: LlmClient;
  profile: ModelProfile;
  clock: Clock;
  systemPrompt: SystemPromptFactory;
  dailyTurnCap: number;
  /** Staff notifications for `escalate_to_human`. Without one, escalations are recorded as FAILED (#23). */
  notifier?: Notifier;
  /** Defaults to `TOOL_REGISTRY`. The eval harness passes its fault-injecting registry. */
  registry?: ToolRegistry;
  limits?: Partial<AgentLimits>;
  /** UUIDs for new conversations and turns. Default `crypto.randomUUID`. */
  newId?: () => string;
  log?: Logger;
  /** Monotonic milliseconds for timings. Default `performance.now`. */
  monotonicNow?: () => number;
}

export interface ChatTurnInput {
  /** The raw request body (already base64-decoded). */
  body: string | null;
  /** The verified JWT `sub` from the authorizer. Never taken from the body (CLAUDE.md rule 1). */
  patientId: string | undefined;
  requestId: string;
  /** Aborts the agent loop (the Lambda's deadline). Persisting and the terminal event still happen. */
  signal?: AbortSignal;
}

/** What happened, for the caller (logs, evals). Contains IDs and enums only. */
export interface ChatTurnSummary {
  status: number;
  /** The terminal event's type and, for errors, its code. */
  terminal: "done" | "error";
  errorCode?: string;
  /** The agent outcome when the loop ran. */
  outcome?: AgentTurnResult["outcome"];
  conversationId?: ConversationId;
  turnId?: TurnId;
  /** True when the body's `conversationId` didn't read as this patient's, and a new one was started. */
  conversationReplaced: boolean;
  /** Messages this turn appended (patient message, assistant/tool messages, closing replies). */
  messagesAppended: number;
}

export async function handleChatTurn(
  input: ChatTurnInput,
  deps: ChatTurnDeps,
  sink: EventSink,
): Promise<ChatTurnSummary> {
  return new ChatTurn(input, deps, sink).run();
}

// ---------------------------------------------------------------------------------------------

const KNOWN_TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);

class ChatTurn {
  readonly #in: ChatTurnInput;
  readonly #deps: ChatTurnDeps;
  readonly #out: EventWriter;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #t0: number;
  readonly #summary: ChatTurnSummary = {
    status: 500,
    terminal: "error",
    conversationReplaced: false,
    messagesAppended: 0,
  };
  /** Facts for the one structured log line per turn. IDs, enums, numbers only (ADR-009). */
  readonly #facts: Record<string, unknown> = {};
  #firstEventMs: number | undefined;

  constructor(input: ChatTurnInput, deps: ChatTurnDeps, sink: EventSink) {
    this.#in = input;
    this.#deps = deps;
    this.#out = new EventWriter(sink);
    this.#log = deps.log ?? silentLogger;
    this.#now = deps.monotonicNow ?? (() => performance.now());
    this.#t0 = this.#now();
  }

  async run(): Promise<ChatTurnSummary> {
    try {
      await this.#turn();
    } catch (error) {
      // Unexpected: a repository or the loop setup threw. Tell the client once if we still can.
      this.#log({
        msg: "chat turn failed",
        level: "error",
        requestId: this.#in.requestId,
        ...errorSummary(error),
      });
      this.#fail(FAILURES.internal());
    } finally {
      await this.#out.end(500);
      this.#log({
        msg: "chat turn",
        requestId: this.#in.requestId,
        ...this.#facts,
        status: this.#summary.status,
        terminal: this.#summary.terminal,
        ...(this.#summary.errorCode === undefined ? {} : { errorCode: this.#summary.errorCode }),
        conversationId: this.#summary.conversationId,
        turnId: this.#summary.turnId,
        conversationReplaced: this.#summary.conversationReplaced,
        messagesAppended: this.#summary.messagesAppended,
        events: this.#out.count,
        firstEventMs: this.#firstEventMs,
        totalMs: this.#elapsed(),
      });
    }
    return this.#summary;
  }

  async #turn(): Promise<void> {
    const { repos, turns, clock } = this.#deps;
    const newId = this.#deps.newId ?? randomUUID;

    // 1. Identity and input.
    const patient = PatientId.safeParse(this.#in.patientId);
    if (!patient.success) return this.#fail(FAILURES.unauthorized());
    const patientId = patient.data;
    const body = parseJsonBody(this.#in.body, ChatRequest);
    if (!body.ok) return this.#fail(FAILURES.badRequest());
    const request = body.value;
    this.#facts.clientMessageId = request.clientMessageId;

    // 2. Daily cap.
    const quota = await turns.consumeDailyTurn(patientId, clinicDateOf(clock.now()), this.#deps.dailyTurnCap);
    this.#facts.turnsUsedToday = quota.used;
    if (!quota.ok) return this.#fail(FAILURES.dailyCap());

    // 3. History, through the owned read only.
    let stored: ConversationMessage[] = [];
    let conversationId: ConversationId;
    if (request.conversationId !== undefined) {
      stored = await repos.conversations.listMessages(patientId, request.conversationId);
    }
    if (request.conversationId !== undefined && stored.length > 0) {
      conversationId = request.conversationId;
    } else {
      conversationId = newId();
      this.#summary.conversationReplaced = request.conversationId !== undefined;
    }
    const turnId = newId();
    this.#summary.conversationId = conversationId;
    this.#summary.turnId = turnId;
    this.#facts.historyMessages = stored.length;

    // 4. The patient's message goes in before the loop runs (closing an interrupted turn first).
    let nextSeq = (stored.at(-1)?.seq ?? -1) + 1;
    const store = async (messages: readonly LlmMessage[]): Promise<number | undefined> => {
      if (messages.length === 0) return undefined;
      const rows = toStoredMessages(messages, {
        conversationId,
        turnId,
        firstSeq: nextSeq,
        createdAt: clock.now().toISOString(),
      });
      for (let i = 0; i < rows.length; i += MAX_APPEND_BATCH) {
        await repos.conversations.append(patientId, rows.slice(i, i + MAX_APPEND_BATCH));
        nextSeq += Math.min(MAX_APPEND_BATCH, rows.length - i);
        this.#summary.messagesAppended += Math.min(MAX_APPEND_BATCH, rows.length - i);
      }
      return rows.at(-1)?.seq;
    };

    const history = toLlmHistory(stored);
    const before: LlmMessage[] = needsClosingReply(history) ? [closingReply()] : [];
    this.#facts.closedInterruptedTurn = before.length > 0;
    const userMessage: LlmMessage = { role: "user", content: [{ type: "text", text: request.text }] };
    try {
      await store([...before, userMessage]);
    } catch (error) {
      if (error instanceof ConversationAppendError) {
        // Another turn of this conversation wrote first. Don't retry blindly (#13 hand-off).
        this.#log({
          msg: "chat append conflict",
          level: "warn",
          requestId: this.#in.requestId,
          code: error.code,
        });
        return this.#fail(FAILURES.conflict());
      }
      throw error;
    }

    // 5. The agent loop, with tools bound to this patient and this (owned) conversation.
    const profileRecord = await repos.patients.get(patientId);
    const executor = createToolExecutor(
      this.#deps.registry ?? TOOL_REGISTRY,
      {
        patientId,
        conversationId,
        clock,
        repos,
        ...(this.#deps.notifier ? { notifier: this.#deps.notifier } : {}),
      },
      {
        onInternalError: (error, call) =>
          this.#log({
            msg: "tool internal error",
            level: "error",
            requestId: this.#in.requestId,
            turnId,
            tool: KNOWN_TOOLS.has(call.name) ? call.name : "<unknown>",
            ...errorSummary(error),
          }),
      },
    );
    const result = await runAgentTurn({
      history: [...history, ...before],
      userMessage: request.text,
      system: this.#deps.systemPrompt({
        now: clock.now(),
        patientFirstName: profileRecord?.firstName ?? null,
      }),
      executor,
      llm: this.#deps.llm,
      profile: this.#deps.profile,
      clock,
      ...(this.#deps.limits ? { limits: this.#deps.limits } : {}),
      onEvent: (event) => this.#send(200, event),
      conversationId,
      turnId,
      ...(this.#in.signal ? { signal: this.#in.signal } : {}),
      monotonicNow: this.#now,
    });
    this.#summary.outcome = result.outcome;
    this.#recordTrace(result);

    // 6. Persist the rest of the turn (newMessages[0] is the patient message, already stored).
    const rest = result.newMessages.slice(1);
    const closing = needsClosingReply([userMessage, ...rest]) ? [closingReply()] : [];
    let replySeq: number | undefined;
    try {
      replySeq = await store([...rest, ...closing]);
    } catch (error) {
      this.#log({
        msg: "chat persist failed",
        level: "error",
        requestId: this.#in.requestId,
        ...errorSummary(error),
      });
      return this.#fail(error instanceof ConversationAppendError ? FAILURES.conflict() : FAILURES.internal());
    }
    try {
      await turns.saveTrace(patientId, result.trace);
    } catch (error) {
      // The trace is for debugging (FR-051); losing one must not fail a turn the patient already saw.
      this.#log({
        msg: "trace save failed",
        level: "warn",
        requestId: this.#in.requestId,
        ...errorSummary(error),
      });
    }

    // 7. Terminal event.
    if (result.outcome === "error") {
      this.#log({
        msg: "agent turn error",
        level: "warn",
        requestId: this.#in.requestId,
        ...errorSummary(result.error),
      });
      return this.#fail(classifyAgentError(result.error));
    }
    if (replySeq === undefined) throw new Error("Completed turn stored no reply");
    this.#send(200, {
      type: "done",
      conversationId,
      messageId: messageIdForSeq(replySeq),
      usage: result.usage,
    });
    this.#summary.terminal = "done";
  }

  #send(statusIfFirst: number, event: Parameters<EventWriter["send"]>[1]): void {
    if (!this.#out.opened) {
      this.#summary.status = statusIfFirst;
      this.#firstEventMs = this.#elapsed();
    }
    if (event.type === "text_delta" && this.#facts.firstTextMs === undefined) {
      this.#facts.firstTextMs = this.#elapsed();
    }
    this.#out.send(statusIfFirst, event);
  }

  #fail(failure: ChatFailure): void {
    this.#summary.terminal = "error";
    this.#summary.errorCode = failure.event.code;
    try {
      this.#send(failure.httpStatus, failure.event);
    } catch {
      // The sink broke; the stream still ends in `run`.
    }
  }

  /** Counts, timings and tokens from the trace. Tool names only: inputs are patient free text. */
  #recordTrace(result: AgentTurnResult): void {
    const { trace } = result;
    Object.assign(this.#facts, {
      outcome: result.outcome,
      modelProfile: trace.modelProfile,
      promptVersion: trace.promptVersion,
      iterations: trace.iterations,
      agentMs: trace.durationMs,
      llmCalls: trace.llmCalls.map((c) => ({
        attempt: c.attempt,
        modelId: c.modelId,
        stopReason: c.stopReason,
        durationMs: c.durationMs,
        ttftMs: c.ttftMs,
      })),
      tools: trace.toolCalls.map((t) => ({
        name: t.known ? t.name : "<unknown>",
        ok: t.ok,
        ...(t.errorCode === undefined ? {} : { errorCode: t.errorCode }),
        durationMs: t.durationMs,
      })),
      usage: result.usage,
    });
  }

  #elapsed(): number {
    return Math.max(0, Math.round(this.#now() - this.#t0));
  }
}
