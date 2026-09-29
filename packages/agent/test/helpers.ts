import type Anthropic from "@anthropic-ai/sdk";
import { type ChatStreamEvent, type ToolName, toolDefinitionsForModel } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";

import {
  type Clock,
  MODEL_PROFILES,
  type RunAgentTurnInput,
  type ScriptedLlmClient,
  type SystemPrompt,
  type ToolCall,
  type ToolExecutionResult,
  type ToolExecutor,
} from "../src";

/** The patient the executor is bound to. It must never appear in anything the loop sends to the model. */
export const PATIENT_ID = EXAMPLES.PatientId;

export const frozenClock: Clock = { now: () => new Date("2026-10-05T13:00:00Z") };

export const SYSTEM: SystemPrompt = {
  version: "system.test",
  stable: "You are the Cedar Ridge Health scheduling assistant. (stable test prompt)",
  dynamic: "Today is Monday, October 5, 2026 (ET). The patient's first name is Maria.",
};

export type ToolHandler = (
  input: unknown,
  boundPatientId: string,
  call: ToolCall,
) => ToolExecutionResult | Promise<ToolExecutionResult>;

export interface FakeExecutor extends ToolExecutor {
  readonly calls: ToolCall[];
}

/**
 * A `ToolExecutor` bound to `PATIENT_ID`, the way the chat handler binds the JWT subject. Tools without
 * a handler return `NOT_FOUND`.
 */
export function fakeExecutor(handlers: Partial<Record<ToolName, ToolHandler>> = {}): FakeExecutor {
  const boundPatientId = PATIENT_ID;
  const calls: ToolCall[] = [];
  return {
    definitions: toolDefinitionsForModel(),
    calls,
    async execute(call) {
      calls.push(call);
      const handler = handlers[call.name as ToolName];
      if (!handler) return { ok: false, error: { error: { code: "NOT_FOUND", message: "No handler" } } };
      return handler(call.input, boundPatientId, call);
    },
  };
}

export const availability = (): ToolExecutionResult => ({
  ok: true,
  output: EXAMPLES.CheckAvailabilityOutput,
});

/** Base input for a turn; override per test. */
export function turnInput(
  llm: ScriptedLlmClient,
  overrides: Partial<RunAgentTurnInput> = {},
): RunAgentTurnInput & { events: ChatStreamEvent[] } {
  const events: ChatStreamEvent[] = [];
  return {
    history: [],
    userMessage: "Do you have any dermatology openings on Tuesday afternoon?",
    system: SYSTEM,
    executor: fakeExecutor({ check_availability: availability }),
    llm,
    profile: MODEL_PROFILES["sonnet-4.6"],
    clock: frozenClock,
    onEvent: (event) => events.push(event),
    conversationId: EXAMPLES.ConversationId,
    turnId: EXAMPLES.TurnId,
    events,
    ...overrides,
  };
}

export function textDeltas(events: ChatStreamEvent[]): string {
  return events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Every value in `value` under a key named `key`, at any depth. */
export function valuesForKey(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((v) => valuesForKey(v, key));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [...(k === key ? [v] : []), ...valuesForKey(v, key)]);
}

/** Every object key in `value`, at any depth. */
export function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)]);
}

export function contentOf(message: Anthropic.MessageParam | undefined): Anthropic.ContentBlockParam[] {
  if (message === undefined) throw new Error("missing message");
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content;
}

export function toolResults(message: Anthropic.MessageParam | undefined): Anthropic.ToolResultBlockParam[] {
  return contentOf(message).filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
