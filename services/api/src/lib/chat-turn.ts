/**
 * The chat turn core behind `POST /api/chat` (S3-03, #17): one patient message in, an NDJSON event
 * stream out. Transport-free, with every dependency injected (CLAUDE.md rule 3), so the Lambda
 * (`handlers/chat.ts`), the integration tests and the eval harness (in-process, #30) run the same code.
 *
 * Order of work, and why:
 * 1. Identity comes from the verified JWT `sub` only (`patientId` here). Bad body → 400. Nothing is
 *    counted or stored for a request that never reaches the agent.
 * 2. History is loaded ONLY through the owned read `listMessages(patientId, conversationId)`. A body
 *    `conversationId` that reads as empty (unknown, expired, or another patient's: they look the same)
 *    is never used: the turn starts a new conversation with a server-generated ID (ADR-004 amendment).
 * 3. Retries (FR-015, #104): a send whose `clientMessageId` is the one stored on the conversation's
 *    LAST patient message is a repeat. Its text must match (400 otherwise). If that message already
 *    has a reply, the reply's visible text is streamed again with no model call (a replay); if it has
 *    none (the turn failed before any tool ran), the agent runs again on it without storing it twice
 *    (a re-run). Neither counts a turn.
 * 4. The daily turn cap (ADR-009) is consumed atomically before any model call, for a new message only.
 * 5. The patient's message is stored, with its `clientMessageId`, BEFORE the agent loop runs, so an
 *    escalation's staff transcript (read from storage, #23) includes it, and a failed turn never loses
 *    it (FR-015).
 * 6. `runAgentTurn` streams `status`, `text_delta` and `text_reset` straight through. The tool executor
 *    is bound to this patient and to the conversation whose history was just loaded.
 * 7. The turn's messages are appended verbatim (reasoning blocks included), then the trace.
 * 8. This module owns the terminal event: `done` (with the stored reply's message ID) or `error`. An
 *    `error` names the conversation whenever it exists in storage, so a Retry after a failed first turn
 *    continues it (FR-014). The stream always ends, whatever throws.
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
  messageIdForSeq,
  type ChatStreamEvent,
  type ConversationId,
  type ConversationMessage,
  type TokenUsage,
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

import { toDisplayMessages } from "./display";
import { FAILURES, classifyAgentError, type ChatFailure } from "./errors";
import {
  closingReply,
  lastPatientMessageIndex,
  needsClosingReply,
  textOf,
  toLlmHistory,
  toStoredMessages,
  type OutgoingMessage,
} from "./history";
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
  /** True when this send repeated an answered message and its stored reply was streamed again (#104). */
  replayed: boolean;
}

export async function handleChatTurn(
  input: ChatTurnInput,
  deps: ChatTurnDeps,
  sink: EventSink,
): Promise<ChatTurnSummary> {
  return new ChatTurn(input, deps, sink).run();
}

// ---------------------------------------------------------------------------------------------

/** A replay makes no model call. */
const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * What a send is, against the loaded history (#104): a new message, or a repeat of the last patient
 * message (`index` in the history) that was answered or interrupted.
 */
type SendKind = { kind: "new" } | { kind: "answered" | "interrupted"; index: number };

/** The conversation a turn writes to, and where its next message goes. */
interface OpenTurn {
  readonly patientId: PatientId;
  readonly conversationId: ConversationId;
  readonly turnId: TurnId;
  nextSeq: number;
}

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
    replayed: false,
  };
  /** Facts for the one structured log line per turn. IDs, enums, numbers only (ADR-009). */
  readonly #facts: Record<string, unknown> = {};
  #firstEventMs: number | undefined;
  /** Set once the conversation exists in storage; `error` events then name it (#104). */
  #storedConversationId: ConversationId | undefined;

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
        replayed: this.#summary.replayed,
        events: this.#out.count,
        firstEventMs: this.#firstEventMs,
        totalMs: this.#elapsed(),
      });
    }
    return this.#summary;
  }

  async #turn(): Promise<void> {
    const admitted = this.#admit();
    if (!admitted) return;
    const { patientId, request } = admitted;
    const stored = await this.#loadHistory(patientId, request.conversationId);

    // 3. A repeat of the last patient message? 4. Only a new message counts a turn.
    const send = this.#classify(stored, request);
    if (!send) return;
    this.#facts.retry = send.kind === "new" ? undefined : send.kind;
    if (send.kind === "new" && !(await this.#consumeDailyTurn(patientId))) return;
    const turn = this.#openTurn(patientId, request.conversationId, stored);
    if (send.kind === "answered") return this.#replay(turn, stored.slice(send.index));

    let history: LlmMessage[];
    if (send.kind === "interrupted") {
      // The patient's message is already stored: run the agent on the history before it (A-5).
      history = toLlmHistory(stored.slice(0, send.index));
    } else {
      // 5. The patient's message goes in before the loop runs (closing an interrupted turn first).
      const earlier = toLlmHistory(stored);
      const before: LlmMessage[] = needsClosingReply(earlier) ? [closingReply()] : [];
      this.#facts.closedInterruptedTurn = before.length > 0;
      const patientMessage: OutgoingMessage = {
        role: "user",
        content: [{ type: "text", text: request.text }],
        clientMessageId: request.clientMessageId,
      };
      if (!(await this.#append(turn, [...before, patientMessage]))) return;
      history = [...earlier, ...before];
    }

    const result = await this.#runAgent(turn, request.text, history);
    this.#summary.outcome = result.outcome;
    this.#recordTrace(result);

    const replySeq = await this.#persistTurn(turn, result);
    if (replySeq === "failed") return;
    this.#finish(turn, result, replySeq);
  }

  /** 1. Identity and input. Undefined when the request was refused. */
  #admit(): { patientId: PatientId; request: ChatRequest } | undefined {
    const patient = PatientId.safeParse(this.#in.patientId);
    if (!patient.success) return this.#fail(FAILURES.unauthorized());
    const patientId = patient.data;
    const body = parseJsonBody(this.#in.body, ChatRequest);
    if (!body.ok) return this.#fail(FAILURES.badRequest());
    const request = body.value;
    this.#facts.clientMessageId = request.clientMessageId;
    return { patientId, request };
  }

  /** 2. History, through the owned read only. Empty for a new, unknown, expired or foreign conversation. */
  async #loadHistory(
    patientId: PatientId,
    requested: ConversationId | undefined,
  ): Promise<ConversationMessage[]> {
    if (requested === undefined) return [];
    return this.#deps.repos.conversations.listMessages(patientId, requested);
  }

  /**
   * 3. Only the last patient message is matched (A-1), so a stale or unknown ID is simply a new send.
   * The same ID with different text is refused (A-2). Undefined when the request was refused.
   */
  #classify(stored: readonly ConversationMessage[], request: ChatRequest): SendKind | undefined {
    const index = lastPatientMessageIndex(stored);
    const last = stored[index];
    if (last?.clientMessageId !== request.clientMessageId) return { kind: "new" };
    if (textOf(last) !== request.text) return this.#fail(FAILURES.badRequest());
    return { kind: index === stored.length - 1 ? "interrupted" : "answered", index };
  }

  /** 4. The daily cap (ADR-009), consumed atomically. False when the patient has reached it. */
  async #consumeDailyTurn(patientId: PatientId): Promise<boolean> {
    const { turns, clock, dailyTurnCap } = this.#deps;
    const quota = await turns.consumeDailyTurn(patientId, clinicDateOf(clock.now()), dailyTurnCap);
    this.#facts.turnsUsedToday = quota.used;
    if (!quota.ok) this.#fail(FAILURES.dailyCap());
    return quota.ok;
  }

  /** The conversation this turn writes to: the requested one if it read as this patient's, else a new one. */
  #openTurn(
    patientId: PatientId,
    requested: ConversationId | undefined,
    stored: readonly ConversationMessage[],
  ): OpenTurn {
    const newId = this.#deps.newId ?? randomUUID;
    let conversationId: ConversationId;
    if (requested !== undefined && stored.length > 0) {
      conversationId = requested;
      this.#storedConversationId = conversationId;
    } else {
      conversationId = newId();
      this.#summary.conversationReplaced = requested !== undefined;
    }
    const turnId = newId();
    this.#summary.conversationId = conversationId;
    this.#summary.turnId = turnId;
    this.#facts.historyMessages = stored.length;
    const nextSeq = (stored.at(-1)?.seq ?? -1) + 1;
    return { patientId, conversationId, turnId, nextSeq };
  }

  /**
   * 3. Stream an answered message's reply again (A-3): the assistant bubble a restored session shows
   * for that turn, as one `text_delta`, then `done` with the bubble's ID. No model call, no counted
   * turn, no trace. A turn whose storing was cut short after a tool ran (a crash between batches) has
   * no reply yet: it gets the closing reply first, as a failure after a tool ran does (Q-3).
   */
  async #replay(turn: OpenTurn, fromPatientMessage: ConversationMessage[]): Promise<void> {
    const closing = needsClosingReply(fromPatientMessage) ? [closingReply()] : [];
    const appended = await this.#append(turn, closing);
    if (!appended) return;
    const reply = toDisplayMessages([...fromPatientMessage, ...appended]).find((m) => m.role === "assistant");
    if (reply === undefined) throw new Error("Answered turn has no reply to replay");
    this.#send(200, { type: "text_delta", text: reply.text });
    this.#send(200, {
      type: "done",
      conversationId: turn.conversationId,
      messageId: reply.id,
      usage: NO_USAGE,
    });
    this.#summary.terminal = "done";
    this.#summary.replayed = true;
  }

  /** Appends messages after the last stored one, in batches. Returns the rows written. */
  async #store(turn: OpenTurn, messages: readonly OutgoingMessage[]): Promise<ConversationMessage[]> {
    if (messages.length === 0) return [];
    const { repos, clock } = this.#deps;
    const rows = toStoredMessages(messages, {
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      firstSeq: turn.nextSeq,
      createdAt: clock.now().toISOString(),
    });
    for (let i = 0; i < rows.length; i += MAX_APPEND_BATCH) {
      const batch = rows.slice(i, i + MAX_APPEND_BATCH);
      await repos.conversations.append(turn.patientId, batch);
      turn.nextSeq += batch.length;
      this.#summary.messagesAppended += batch.length;
      this.#storedConversationId = turn.conversationId;
    }
    return rows;
  }

  /**
   * Stores messages the turn needs before it can answer: the patient's message before the agent runs,
   * or a replay's closing reply. The rows written, or undefined when another turn of this conversation
   * wrote first (the turn has then failed with a conflict).
   */
  async #append(
    turn: OpenTurn,
    messages: readonly OutgoingMessage[],
  ): Promise<ConversationMessage[] | undefined> {
    try {
      return await this.#store(turn, messages);
    } catch (error) {
      if (!(error instanceof ConversationAppendError)) throw error;
      // Another turn of this conversation wrote first. Don't retry blindly (#13 hand-off).
      this.#log({
        msg: "chat append conflict",
        level: "warn",
        requestId: this.#in.requestId,
        code: error.code,
      });
      this.#fail(FAILURES.conflict());
      return undefined;
    }
  }

  /** 6. The agent loop, with tools bound to this patient and this (owned) conversation. */
  async #runAgent(turn: OpenTurn, text: string, history: LlmMessage[]): Promise<AgentTurnResult> {
    const { repos, clock, notifier, limits } = this.#deps;
    const { patientId, conversationId, turnId } = turn;
    const profileRecord = await repos.patients.get(patientId);
    const executor = createToolExecutor(
      this.#deps.registry ?? TOOL_REGISTRY,
      { patientId, conversationId, clock, repos, ...(notifier ? { notifier } : {}) },
      {
        // The executor reports internal errors only for registered tools, so the name is a known one.
        onInternalError: (error, call) =>
          this.#log({
            msg: "tool internal error",
            level: "error",
            requestId: this.#in.requestId,
            turnId,
            tool: call.name,
            ...errorSummary(error),
          }),
      },
    );
    return runAgentTurn({
      history,
      userMessage: text,
      system: this.#deps.systemPrompt({
        now: clock.now(),
        patientFirstName: profileRecord?.firstName ?? null,
      }),
      executor,
      llm: this.#deps.llm,
      profile: this.#deps.profile,
      clock,
      ...(limits ? { limits } : {}),
      onEvent: (event) => this.#send(200, event),
      conversationId,
      turnId,
      ...(this.#in.signal ? { signal: this.#in.signal } : {}),
      monotonicNow: this.#now,
    });
  }

  /**
   * 7. Persist the rest of the turn (newMessages[0] is the patient message, already stored), then the
   * trace. Returns the reply's seq, or "failed" when storing failed and the turn has ended with an error.
   * A turn that failed after a tool ran is closed now; one that failed before any tool ran is left
   * ending at the patient's message, for a Retry to run again (Q-1, `closingReply`).
   */
  async #persistTurn(turn: OpenTurn, result: AgentTurnResult): Promise<number | undefined | "failed"> {
    const rest = result.newMessages.slice(1);
    // `rest` is empty when the turn failed before any tool ran: nothing to close.
    const closing = needsClosingReply(rest) ? [closingReply()] : [];
    let replySeq: number | undefined;
    try {
      replySeq = (await this.#store(turn, [...rest, ...closing])).at(-1)?.seq;
    } catch (error) {
      this.#log({
        msg: "chat persist failed",
        level: "error",
        requestId: this.#in.requestId,
        ...errorSummary(error),
      });
      this.#fail(error instanceof ConversationAppendError ? FAILURES.conflict() : FAILURES.internal());
      return "failed";
    }
    try {
      await this.#deps.turns.saveTrace(turn.patientId, result.trace);
    } catch (error) {
      // The trace is for debugging (FR-051); losing one must not fail a turn the patient already saw.
      this.#log({
        msg: "trace save failed",
        level: "warn",
        requestId: this.#in.requestId,
        ...errorSummary(error),
      });
    }
    return replySeq;
  }

  /** 8. Terminal event. */
  #finish(turn: OpenTurn, result: AgentTurnResult, replySeq: number | undefined): void {
    if (result.outcome === "error") {
      this.#log({
        msg: "agent turn error",
        level: "warn",
        requestId: this.#in.requestId,
        ...errorSummary(result.error),
      });
      this.#fail(classifyAgentError(result.error));
      return;
    }
    if (replySeq === undefined) throw new Error("Completed turn stored no reply");
    this.#send(200, {
      type: "done",
      conversationId: turn.conversationId,
      messageId: messageIdForSeq(replySeq),
      usage: result.usage,
    });
    this.#summary.terminal = "done";
  }

  #send(statusIfFirst: number, event: ChatStreamEvent): void {
    if (!this.#out.opened) {
      this.#summary.status = statusIfFirst;
      this.#firstEventMs = this.#elapsed();
    }
    if (event.type === "text_delta" && this.#facts.firstTextMs === undefined) {
      this.#facts.firstTextMs = this.#elapsed();
    }
    this.#out.send(statusIfFirst, event);
  }

  #fail(failure: ChatFailure): undefined {
    this.#summary.terminal = "error";
    this.#summary.errorCode = failure.event.code;
    const conversationId = this.#storedConversationId;
    try {
      this.#send(
        failure.httpStatus,
        conversationId === undefined ? failure.event : { ...failure.event, conversationId },
      );
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
