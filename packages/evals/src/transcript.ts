/**
 * A flat, grader-friendly view of a conversation: patient messages, visible assistant text, and tool
 * calls with their results, in the order they happened. Built from the loop's stored messages and trace,
 * so it sees exactly what the patient saw and what the tools returned.
 */
import { TEXT_BLOCK_SEPARATOR, type LlmMessage } from "@sched/agent";
import type { ToolCallTrace, ToolError } from "@sched/contracts";

export type TranscriptEvent =
  | {
      kind: "patient";
      turn: number;
      text: string;
      /** 1-based index into `script`, when scripted. */
      scriptStep?: number;
    }
  | { kind: "assistant"; turn: number; text: string }
  | {
      kind: "tool_call";
      turn: number;
      id: string;
      name: string;
      /** False when the model called a tool it wasn't offered. */
      known: boolean;
      input: unknown;
      ok: boolean;
      /** Parsed tool output when `ok`. */
      output?: unknown;
      /** Parsed ToolError when not `ok`. */
      error?: ToolError["error"];
    };

export type ToolCallEvent = Extract<TranscriptEvent, { kind: "tool_call" }>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Events for one turn from `AgentTurnResult.newMessages` (user message first) and the turn's tool-call
 * trace. Assistant text blocks in one message become one event, joined like the loop joins them.
 */
export function turnEvents(
  turn: number,
  newMessages: readonly LlmMessage[],
  toolTrace: readonly ToolCallTrace[],
  scriptStep?: number,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const m of newMessages)
    for (const b of m.content)
      if (b.type === "tool_result")
        results.set(b.toolUseId, { content: b.content, isError: b.isError === true });
  const known = new Map(toolTrace.map((t) => [t.toolUseId, t.known]));

  for (const [i, m] of newMessages.entries()) {
    if (m.role === "user") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(TEXT_BLOCK_SEPARATOR);
      if (i === 0 || text.length > 0)
        events.push({ kind: "patient", turn, text, ...(scriptStep === undefined ? {} : { scriptStep }) });
      continue;
    }
    const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(TEXT_BLOCK_SEPARATOR);
    if (text.length > 0) events.push({ kind: "assistant", turn, text });
    for (const b of m.content) {
      if (b.type !== "tool_use") continue;
      const result = results.get(b.id);
      const parsed = result === undefined ? undefined : parseJson(result.content);
      const ok = result !== undefined && !result.isError;
      events.push({
        kind: "tool_call",
        turn,
        id: b.id,
        name: b.name,
        known: known.get(b.id) ?? false,
        input: b.input,
        ok,
        ...(ok ? { output: parsed } : {}),
        ...(!ok && typeof parsed === "object" && parsed !== null && "error" in parsed
          ? { error: (parsed as ToolError).error }
          : {}),
      });
    }
  }
  return events;
}

export const assistantTexts = (events: readonly TranscriptEvent[]): string[] =>
  events.flatMap((e) => (e.kind === "assistant" ? [e.text] : []));

export const patientTexts = (events: readonly TranscriptEvent[]): string[] =>
  events.flatMap((e) => (e.kind === "patient" ? [e.text] : []));

/** The slot a write call targets, if any. */
export function targetSlotOf(tool: string, input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const value =
    tool === "book_appointment"
      ? record.slot_id
      : tool === "reschedule_appointment"
        ? record.new_slot_id
        : undefined;
  return typeof value === "string" ? value : undefined;
}

export const toolCalls = (events: readonly TranscriptEvent[]): ToolCallEvent[] =>
  events.filter((e): e is ToolCallEvent => e.kind === "tool_call");
