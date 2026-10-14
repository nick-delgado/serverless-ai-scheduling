/**
 * What an end-to-end turn did, read from its `/api/chat` response body, and the checks on a scripted write (#40,
 * r1/Q-2 (a)). Pure: the specs feed it response bodies and the chip labels the page showed, so the Vitest tests
 * beside it can be seen failing without a browser or a model call.
 *
 * The replies come from a live model, so nothing here reads their wording. A turn keeps its visible text only so the
 * escalation spec can look for the front desk's number (a fixed fact, FR-034); `describeTurn` never prints it.
 */
import {
  type ChatErrorCode,
  type ChatStreamEvent,
  isTerminalEvent,
  parseChatResponseBody,
  TOOL_STATUS_LABELS,
  type ToolName,
  visibleText,
} from "@sched/contracts";

/** One patient turn as the suite saw it. */
export interface TurnRecord {
  /** 0-based position in the conversation's patient turns. */
  index: number;
  /** The `status` events' tools, in stream order, repeats included (the DOM drops a repeated label; this doesn't). */
  tools: ToolName[];
  /** The chip labels the page showed while the turn streamed, in order of appearance. */
  chips: string[];
  /** From `done` (or `conversation`, or a failed turn's `error`), when the stream named one. */
  conversationId?: string;
  /** A turn that ended with an `error` event. */
  errorCode?: ChatErrorCode;
  /** That error event's `retryable`. */
  retryable?: boolean;
  /** The reply as the patient saw it. Never printed. */
  text: string;
}

/** The parts of a turn its `/api/chat` body gives (everything but its index and chips). */
export type StreamedTurn = Pick<TurnRecord, "tools" | "conversationId" | "errorCode" | "retryable" | "text">;

/**
 * Reads one turn's `/api/chat` body, NDJSON or the buffered array. Throws when an event breaks the contract, or when
 * the body doesn't end with `done` or `error` (a cut-off stream or an empty body): the rule the app's own stream client
 * applies (`streamClient.ts`), so a broken stream never reads as a clean turn. A body the page couldn't read never
 * gets here: `turnEnd` (`support/chat.ts`) throws for it first.
 */
export function readTurnBody(body: string): StreamedTurn {
  const events: ChatStreamEvent[] = parseChatResponseBody(body);
  if (!isTerminalEvent(events.at(-1))) throw new Error("The /api/chat stream ended without done or error");
  const turn: StreamedTurn = { tools: [], text: visibleText(events) };
  for (const event of events) {
    if (event.type === "status") turn.tools.push(event.tool);
    else if (event.type === "conversation" || event.type === "done")
      turn.conversationId = event.conversationId;
    else if (event.type === "error") {
      turn.errorCode = event.code;
      turn.retryable = event.retryable;
      if (event.conversationId !== undefined) turn.conversationId = event.conversationId;
    }
  }
  return turn;
}

/**
 * Retries of one patient turn the account's Bedrock quota throttled (a retryable `RATE_LIMITED`, "The assistant is
 * busy"): `sonnet-4.6` has 10 requests a minute for the whole account, and a booking turn makes several. The daily
 * turn cap's `RATE_LIMITED` isn't retryable, and nothing else is retried.
 */
export const MAX_THROTTLE_RETRIES = 3;
/** Seconds to wait before retry `n` (1-based): 20, 40, 60, enough for a minute's quota to refill. */
export const throttleDelayMs = (retry: number): number => 20_000 * retry;

/** Whether a turn's latest attempt, after `retries` retries, is retried (with the app's Retry button). */
export function shouldRetryTurn(turn: StreamedTurn, retries: number): boolean {
  return turn.errorCode === "RATE_LIMITED" && turn.retryable === true && retries < MAX_THROTTLE_RETRIES;
}

/** One patient turn over its attempts: every attempt's tools in order, and the last attempt's outcome and text. */
export function mergeAttempts(attempts: readonly StreamedTurn[]): StreamedTurn {
  const last = attempts.at(-1);
  if (!last) throw new Error("A turn has at least one attempt");
  const merged: StreamedTurn = { ...last, tools: attempts.flatMap((a) => a.tools) };
  merged.conversationId = attempts.findLast((a) => a.conversationId !== undefined)?.conversationId;
  if (merged.conversationId === undefined) delete merged.conversationId;
  return merged;
}

/** The turn's tools and chip count for the run log: no reply text, no message text. */
export function describeTurn(turn: TurnRecord): string {
  const tools = turn.tools.length > 0 ? turn.tools.join(", ") : "none";
  const error = turn.errorCode === undefined ? "" : `, error ${turn.errorCode}`;
  return `turn ${String(turn.index + 1)}: tools [${tools}], ${String(turn.chips.length)} chip(s)${error}`;
}

/** The fixed patient script of a booking or a reschedule (r1/Q-2 (a)). */
export interface WriteScript {
  /** Names the provider, the reason and the day. */
  request: string;
  /** "The earliest of those works for me." */
  choose: string;
  /** "Yes, please book it." (or the reschedule's phrase): the first confirmation, repeated while no write has run. */
  confirm: string;
}

/** The patient turn that carries the first confirmation (0-based): after the request and the choice. */
const FIRST_CONFIRM_TURN = 2;
/** At most this many patient turns in a scripted write: the three scripted ones and up to 3 repeated confirmations. */
export const MAX_SCRIPT_TURNS = 6;

const ran = (turn: TurnRecord, tool: ToolName): number => turn.tools.filter((t) => t === tool).length;

/**
 * The script's next message after `turns`, or undefined when it's over: the write ran (in any turn, even too early),
 * a turn failed, or `MAX_SCRIPT_TURNS` were sent.
 */
export function nextScriptMessage(
  script: WriteScript,
  turns: readonly TurnRecord[],
  tool: ToolName,
): string | undefined {
  if (turns.some((turn) => ran(turn, tool) > 0 || turn.errorCode !== undefined)) return undefined;
  if (turns.length >= MAX_SCRIPT_TURNS) return undefined;
  if (turns.length === 0) return script.request;
  if (turns.length === 1) return script.choose;
  return script.confirm;
}

/**
 * What's wrong with a scripted write's turns; empty when the confirmation step held (r1/Q-2 (a)):
 *   - no `tool` status event in a turn before `FIRST_CONFIRM_TURN`;
 *   - exactly one in the turns from it on;
 *   - the turn that ran it showed `TOOL_STATUS_LABELS[tool]` as a chip;
 *   - no turn ended with an error.
 * The end state is the spec's to check (`end-state.ts`).
 */
export function confirmationProblems(turns: readonly TurnRecord[], tool: ToolName): string[] {
  const problems: string[] = [];
  for (const turn of turns) {
    if (turn.errorCode !== undefined)
      problems.push(`turn ${String(turn.index + 1)} ended with ${turn.errorCode}`);
  }
  const early = turns.filter((turn) => turn.index < FIRST_CONFIRM_TURN && ran(turn, tool) > 0);
  for (const turn of early) {
    problems.push(`${tool} ran in turn ${String(turn.index + 1)}, before the confirmation`);
  }
  const confirmed = turns.filter((turn) => turn.index >= FIRST_CONFIRM_TURN);
  const writes = confirmed.reduce((sum, turn) => sum + ran(turn, tool), 0);
  if (writes !== 1) {
    problems.push(`${tool} ran ${String(writes)} time(s) from the confirmation on; expected exactly 1`);
  }
  const label = TOOL_STATUS_LABELS[tool];
  for (const turn of confirmed) {
    if (ran(turn, tool) > 0 && !turn.chips.includes(label)) {
      problems.push(`turn ${String(turn.index + 1)} ran ${tool} but showed no "${label}" chip`);
    }
  }
  return problems;
}

/** What's wrong with an escalation turn: it must run `escalate_to_human` in the request's own turn (FR-034). */
export function escalationProblems(turn: TurnRecord, phone: string): string[] {
  const problems: string[] = [];
  if (turn.errorCode !== undefined) problems.push(`the turn ended with ${turn.errorCode}`);
  if (ran(turn, "escalate_to_human") === 0)
    problems.push("escalate_to_human didn't run in the request's turn");
  else if (!turn.chips.includes(TOOL_STATUS_LABELS.escalate_to_human)) {
    problems.push(`no "${TOOL_STATUS_LABELS.escalate_to_human}" chip`);
  }
  if (!turn.text.includes(phone)) problems.push("the reply doesn't give the front desk's number");
  return problems;
}
