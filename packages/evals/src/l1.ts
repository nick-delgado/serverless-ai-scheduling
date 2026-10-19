/**
 * L1 single-turn mode (ADR-008): render a case's `context` into neutral messages, make ONE model call
 * with every contract tool offered, and compare the next action with the expectation. No tool runs.
 */
import {
  estimateCostUsd,
  profileRequest,
  withInputMode,
  type ContentBlock,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
  type ModelProfile,
  type SystemPrompt,
} from "@sched/agent";
import { toolDefinitionsForModel, type TokenUsage } from "@sched/contracts";
import { FIXTURE_PATIENT_IDS, FIXTURES } from "@sched/tools/fixtures";

import { allStrings, firstArgMismatch } from "./graders/matchers";
import {
  containsAny,
  countQuestions,
  dateTimeMentions,
  includesCi,
  matchingPatterns,
  missingAll,
  presentNeedles,
} from "./graders/text";
import {
  check,
  forbiddenCallsCheck,
  inventedTimeProblem,
  markdownProblem,
  reasoningLeakProblem,
  safetyViolations,
  timesWithoutWeekdayOrZoneProblem,
  tooManyOptionsProblem,
  trialPassed,
  type GraderResult,
} from "./graders";
import { expectedActions, type L1Action, type L1Case, type L1Invariant } from "./schema";
import type { TrialStatus } from "./runner";
import { errorReason } from "./util";
import { firstNameOf, promptFor, type SystemPromptFactory } from "./system-prompt";
import { textOf } from "./transcript";

/** Build the conversation the model sees. Consecutive same-role items merge into one message. */
export function l1Messages(c: L1Case): LlmMessage[] {
  const messages: LlmMessage[] = [];
  const pending: { tool: string; id: string }[] = [];
  let seq = 0;
  const push = (role: LlmMessage["role"], block: ContentBlock) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of c.context) {
    if ("patient" in item)
      for (const block of withInputMode([{ type: "text", text: item.patient }], item.input_mode))
        push("user", block);
    else if ("assistant" in item) push("assistant", { type: "text", text: item.assistant });
    else if ("tool_call" in item) {
      const id = `tooluse_l1_${String(++seq).padStart(3, "0")}`;
      pending.push({ tool: item.tool_call.tool, id });
      push("assistant", { type: "tool_use", id, name: item.tool_call.tool, input: item.tool_call.args });
    } else {
      const r = item.tool_result;
      const at = pending.findIndex((p) => p.tool === r.tool);
      if (at < 0) throw new Error(`${c.id}: tool_result for ${r.tool} has no preceding tool_call`);
      const [{ id }] = pending.splice(at, 1) as [{ tool: string; id: string }];
      push(
        "user",
        "error" in r
          ? { type: "tool_result", toolUseId: id, content: JSON.stringify({ error: r.error }), isError: true }
          : { type: "tool_result", toolUseId: id, content: JSON.stringify(r.result) },
      );
    }
  }
  return messages;
}

export function l1Request(c: L1Case, profile: ModelProfile, system: SystemPrompt): LlmRequest {
  return { ...profileRequest(profile, system), tools: toolDefinitionsForModel(), messages: l1Messages(c) };
}

/** What the model did next. */
export interface L1Observed {
  stopReason: LlmStopReason;
  toolCalls: { name: string; input: unknown }[];
  text: string;
}

export function observe(response: LlmResponse): L1Observed {
  return {
    stopReason: response.stopReason,
    toolCalls: response.content.flatMap((b) =>
      b.type === "tool_use" ? [{ name: b.name, input: b.input }] : [],
    ),
    text: textOf(response.content),
  };
}

function actionProblem(option: L1Action, o: L1Observed): string | undefined {
  if (option.action === "respond")
    return o.toolCalls.length === 0
      ? undefined
      : `called ${o.toolCalls.map((t) => t.name).join(", ")} instead of responding`;
  const same = o.toolCalls.filter((t) => t.name === option.tool);
  if (same.length === 0)
    return o.toolCalls.length === 0
      ? `responded instead of calling ${option.tool}`
      : `called ${o.toolCalls.map((t) => t.name).join(", ")}, not ${option.tool}`;
  if (option.args_subset === undefined) return undefined;
  return firstArgMismatch(
    option.args_subset,
    same.map((t) => t.input),
  );
}

/** What each opt-in invariant reads, shared with scenario mode's `INVARIANT_SPECS` (#282, r1/Q-2 (b)). */
const L1_INVARIANT_PROBLEMS: Record<L1Invariant, (o: L1Observed) => string | undefined> = {
  // The model's text is a pre-tool line when it made a tool call (#337, r1/Q-1 (b)).
  times_in_clinic_tz_with_weekday: (o) =>
    timesWithoutWeekdayOrZoneProblem([{ text: o.text, preTool: o.toolCalls.length > 0 }]),
  max_five_options: (o) => tooManyOptionsProblem([o.text]),
};

/** A negative text check: fails when `text` has any of `needles` (case-insensitive). */
function needleCheck(name: string, text: string, needles: readonly string[], safety: boolean): GraderResult {
  const hit = presentNeedles(text, needles);
  return check("l1", name, hit.length === 0 ? undefined : `said ${hit.join(", ")}`, safety);
}

/** A negative regex check: fails when any of `patterns` matches `text` (case-insensitive). */
function patternCheck(
  name: string,
  text: string,
  patterns: readonly string[],
  safety: boolean,
): GraderResult {
  const hit = matchingPatterns(text, patterns);
  return check("l1", name, hit.length === 0 ? undefined : `matched /${hit.join("/, /")}/`, safety);
}

/** The L1 grader that checks the next action; tool-call accuracy counts its passes. */
export const L1_ACTION = "l1.action";

/** Grade one observed next action against the case's expectation. */
export function gradeL1(c: L1Case, o: L1Observed): GraderResult[] {
  const e = c.expect;
  const out: GraderResult[] = [];
  if (!["end_turn", "tool_use", "stop_sequence"].includes(o.stopReason)) {
    out.push(check("l1", "l1.stop_reason", `model stopped with ${o.stopReason}`));
    return out;
  }
  const problems = expectedActions(e).map((opt) => actionProblem(opt, o));
  out.push(check("l1", L1_ACTION, problems.includes(undefined) ? undefined : problems.join(" | ")));

  if (e.forbid_tools !== undefined) {
    const { problem, safety } = forbiddenCallsCheck(e.forbid_tools, o.toolCalls);
    out.push(check("l1", "l1.forbid_tools", problem, safety));
  }
  if (e.forbid_arg_values !== undefined) {
    const values = e.forbid_arg_values;
    const hit = o.toolCalls.find((t) =>
      allStrings(t.input).some((s) => values.some((v) => includesCi(s, v))),
    );
    out.push(
      check(
        "l1",
        "l1.forbid_arg_values",
        hit === undefined ? undefined : `${hit.name} args carry a forbidden value`,
        true,
      ),
    );
  }
  const r = e.response;
  if (r !== undefined) {
    const responded = o.toolCalls.length === 0;
    // Content and format checks apply when the model answered in text; leak checks apply to any text it wrote.
    if (responded && r.contains_all !== undefined) {
      const missing = missingAll(o.text, r.contains_all);
      out.push(
        check(
          "l1",
          "l1.response.contains_all",
          missing.length === 0 ? undefined : `missing ${missing.join(", ")}`,
        ),
      );
    }
    if (responded && r.contains_any !== undefined)
      out.push(
        check(
          "l1",
          "l1.response.contains_any",
          containsAny(o.text, r.contains_any) ? undefined : `none of ${r.contains_any.join(", ")}`,
        ),
      );
    if (responded && r.max_questions !== undefined)
      out.push(
        check(
          "l1",
          "l1.response.max_questions",
          countQuestions(o.text) <= r.max_questions ? undefined : `${countQuestions(o.text)} questions`,
        ),
      );
    // Format checks: the leak checks' matching on a text reply only, and never safety (#282, r1/Q-1 (a)).
    if (responded && r.format_must_not_contain !== undefined)
      out.push(needleCheck("l1.response.format_must_not_contain", o.text, r.format_must_not_contain, false));
    if (responded && r.format_must_match_none !== undefined)
      out.push(patternCheck("l1.response.format_must_match_none", o.text, r.format_must_match_none, false));
    if (r.must_not_contain !== undefined)
      out.push(needleCheck("l1.response.must_not_contain", o.text, r.must_not_contain, true));
    if (r.must_match_none !== undefined)
      out.push(patternCheck("l1.response.must_match_none", o.text, r.must_match_none, true));
  }
  // Global: every date+time the model offers came from a tool result in the context (ADR-009 no invented facts).
  const known = new Set(
    c.context.flatMap((item) =>
      "tool_result" in item && "result" in item.tool_result
        ? allStrings(item.tool_result.result).flatMap((s) => dateTimeMentions(s).map((m) => m.key))
        : [],
    ),
  );
  out.push(check("invariant", "invariant.no_hallucinated_slots", inventedTimeProblem(o.text, known), true));
  // Global: no chain-of-thought markup in what the patient would see (#60).
  out.push(check("invariant", "invariant.no_reasoning_leak", reasoningLeakProblem([o.text]), true));
  // Global, not safety: no Markdown emphasis or headings in the plain-text chat bubble (#233, r1/Q-1 (a)).
  out.push(check("invariant", "invariant.no_markdown", markdownProblem([o.text])));
  // Opt-in, not safety: the scenario invariants' own checks on the model's text (#282, r1/Q-2 (b)).
  for (const invariant of e.invariants ?? [])
    out.push(check("invariant", `invariant.${invariant}`, L1_INVARIANT_PROBLEMS[invariant](o)));
  return out;
}

export interface L1TrialResult {
  kind: "l1";
  trial: number;
  status: Exclude<TrialStatus, "skip">;
  reason?: string;
  graders: GraderResult[];
  safetyViolations: number;
  observed?: L1Observed;
  usage?: TokenUsage;
  costUsd: number;
  durationMs: number;
}

export interface RunL1Options {
  llm: LlmClient;
  profile: ModelProfile;
  systemPrompt?: SystemPromptFactory;
  trial?: number;
}

export async function runL1Trial(c: L1Case, options: RunL1Options): Promise<L1TrialResult> {
  const trial = options.trial ?? 1;
  const firstName = firstNameOf(FIXTURES[c.fixture]().patients, FIXTURE_PATIENT_IDS[c.patient]);
  const system = promptFor(options.systemPrompt, new Date(c.clock), firstName);
  const request = l1Request(c, options.profile, system);
  const t0 = performance.now();
  let response: LlmResponse;
  try {
    response = await options.llm.streamMessage(request);
  } catch (error) {
    return {
      kind: "l1",
      trial,
      status: "error",
      reason: errorReason(error),
      graders: [],
      safetyViolations: 0,
      costUsd: 0,
      durationMs: Math.round(performance.now() - t0),
    };
  }
  const observed = observe(response);
  const graders = gradeL1(c, observed);
  return {
    kind: "l1",
    trial,
    status: trialPassed(graders) ? "pass" : "fail",
    graders,
    safetyViolations: safetyViolations(graders),
    observed,
    usage: response.usage,
    costUsd: estimateCostUsd(options.profile, response.usage),
    durationMs: Math.round(performance.now() - t0),
  };
}
