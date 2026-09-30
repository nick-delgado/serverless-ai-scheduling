/**
 * Tool registry and executor: the tools side of the seam with the agent loop (#15).
 *
 * `packages/agent` owns the port (`ToolExecutor`); this module implements it structurally, with no import
 * in either direction. The caller (chat handler or eval harness) binds the verified patient identity into
 * a ToolContext when it creates the executor, so the loop never sees or passes a patient ID and the model
 * can't choose one (CLAUDE.md rule 1).
 *
 * The executor owns validation, so handlers don't repeat it:
 * - unknown or unregistered tool → NOT_FOUND;
 * - input checked against `TOOLS[name].input` (strict: an extra `patient_id` is rejected) → INVALID_INPUT;
 * - the handler gets the parsed input (defaults applied) and the frozen ToolContext;
 * - its output is checked against `TOOLS[name].output`; a thrown error or a non-conforming result → INTERNAL,
 *   with a generic message (internals are reported to `onInternalError`, never to the model).
 */
import {
  PatientId,
  ConversationId,
  TOOL_NAMES,
  ToolError,
  ToolName,
  TOOLS,
  toolDefinitionsForModel,
  type ModelToolDefinition,
  type ToolErrorCode,
  type ToolInput,
  type ToolOutput,
} from "@sched/contracts";

import type { Clock } from "./clock";
import type { Repositories } from "./repos/types";

// Tool handlers: each tool issue adds its import under its own line (keeps parallel PRs conflict-free).
// #19 find_providers, check_availability
import { checkAvailability } from "./tools/check_availability";
import { findProviders } from "./tools/find_providers";

// #20 get_my_appointments, get_patient_profile

// #21 book_appointment

// #22 reschedule_appointment

// #23 escalate_to_human

// ---------------------------------------------------------------------------------------------
// The seam (structurally identical to the port in packages/agent)
// ---------------------------------------------------------------------------------------------

export interface ToolCall {
  /** The model's `tool_use` id. */
  id: string;
  name: string;
  input: unknown;
}

export type ToolExecutionResult = { ok: true; output: unknown } | { ok: false; error: ToolError };

export interface ToolExecutor {
  /** Model-facing definitions for the registered tools, in the stable contracts order. */
  readonly definitions: readonly ModelToolDefinition[];
  /** Never throws: every failure becomes a ToolError the loop can return as an `is_error` tool_result. */
  execute(call: ToolCall): Promise<ToolExecutionResult>;
}

// ---------------------------------------------------------------------------------------------
// Handlers and registry
// ---------------------------------------------------------------------------------------------

/** What a handler may use. `patientId` comes from the verified JWT, never from tool input. */
export interface ToolContext {
  readonly patientId: PatientId;
  readonly conversationId: ConversationId;
  readonly clock: Clock;
  readonly repos: Repositories;
}

export type ToolHandlerResult<N extends ToolName> =
  { ok: true; output: ToolOutput<N> } | { ok: false; error: ToolError };

/** A tool implementation. Input is already validated and defaulted; the output is validated after. */
export type ToolHandler<N extends ToolName> = (
  input: ToolInput<N>,
  ctx: ToolContext,
) => Promise<ToolHandlerResult<N>>;

export type ToolRegistry = { readonly [N in ToolName]?: ToolHandler<N> };

/** Success result for a handler (the handler's `ToolHandler<N>` return type checks the output shape). */
export function toolOk<O>(output: O): { ok: true; output: O } {
  return { ok: true, output };
}

/** Failure result for a handler. `hint` tells the model what to do next. */
export function toolFail(
  code: ToolErrorCode,
  message: string,
  hint?: string,
): { ok: false; error: ToolError } {
  return { ok: false, error: { error: hint === undefined ? { code, message } : { code, message, hint } } };
}

/**
 * The production registry. Tool issues (#19–#23) each add one entry under their comment.
 * A tool is offered to the model only once its handler is registered here.
 */
export const TOOL_REGISTRY: ToolRegistry = {
  // #19 find_providers, check_availability
  find_providers: findProviders,
  check_availability: checkAvailability,
  // #20 get_my_appointments, get_patient_profile
  // #21 book_appointment
  // #22 reschedule_appointment
  // #23 escalate_to_human
};

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

export interface ToolExecutorOptions {
  /** Called with the real cause whenever a call ends in INTERNAL (for structured logs, NFR-007). */
  onInternalError?: (error: unknown, call: ToolCall) => void;
}

type ErasedHandler = (input: unknown, ctx: ToolContext) => Promise<ToolHandlerResult<ToolName>>;

const MAX_MESSAGE = 300;
const clip = (text: string, max = MAX_MESSAGE): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const internalError = (): { ok: false; error: ToolError } =>
  toolFail(
    "INTERNAL",
    "The tool failed unexpectedly.",
    "Try once more. If it fails again, apologize and offer to connect the patient with the front desk.",
  );

function describeIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function registeredNames(registry: ToolRegistry): Set<ToolName> {
  return new Set(TOOL_NAMES.filter((name) => Object.hasOwn(registry, name) && registry[name] !== undefined));
}

/**
 * Create the executor for one conversation turn.
 *
 * Definitions cover only registered tools (in `toolDefinitionsForModel()` order): the model is never offered
 * a tool that can only answer NOT_FOUND. With all seven registered they equal `toolDefinitionsForModel()`
 * exactly, and they're computed once, so the bytes stay stable for the prompt cache.
 */
export function createToolExecutor(
  registry: ToolRegistry,
  ctx: ToolContext,
  options: ToolExecutorOptions = {},
): ToolExecutor {
  const context: ToolContext = Object.freeze({
    patientId: PatientId.parse(ctx.patientId),
    conversationId: ConversationId.parse(ctx.conversationId),
    clock: ctx.clock,
    repos: ctx.repos,
  });
  const registered = registeredNames(registry);
  const definitions = Object.freeze(
    toolDefinitionsForModel()
      .filter((d) => registered.has(d.name))
      .map((d) => Object.freeze(d)),
  );

  const internal = (error: unknown, call: ToolCall): ToolExecutionResult => {
    try {
      options.onInternalError?.(error, call);
    } catch {
      // A failing error hook must not turn a tool error into a thrown one.
    }
    return internalError();
  };

  return {
    definitions,
    async execute(call: ToolCall): Promise<ToolExecutionResult> {
      const parsedName = ToolName.safeParse(call.name);
      if (!parsedName.success || !registered.has(parsedName.data)) {
        const shown = clip(String(call.name), 64);
        return toolFail(
          "NOT_FOUND",
          `No tool named "${shown}" is available.`,
          "Use only the tools you were given.",
        );
      }
      const name = parsedName.data;
      const handler = registry[name] as ErasedHandler | undefined;
      if (!handler) return internal(new Error(`Handler for ${name} disappeared`), call);

      const input = TOOLS[name].input.safeParse(call.input);
      if (!input.success) {
        return toolFail(
          "INVALID_INPUT",
          clip(`Invalid input for ${name}: ${describeIssues(input.error.issues)}`),
          "Fix the listed fields and call the tool again.",
        );
      }

      let result: ToolHandlerResult<ToolName>;
      try {
        result = await handler(input.data, context);
      } catch (error) {
        return internal(error, call);
      }

      if (result.ok) {
        const output = TOOLS[name].output.safeParse(result.output);
        if (!output.success) {
          return internal(
            new Error(`${name} returned invalid output: ${describeIssues(output.error.issues)}`),
            call,
          );
        }
        return { ok: true, output: output.data };
      }
      const error = ToolError.safeParse(result.error);
      if (!error.success) {
        return internal(
          new Error(`${name} returned an invalid ToolError: ${describeIssues(error.error.issues)}`),
          call,
        );
      }
      return { ok: false, error: error.data };
    },
  };
}
