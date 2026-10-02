/**
 * Shared test fixtures: case lookups, grader-result lookup, transcript event builders, fixture ids, the
 * production INTERNAL tool error (so fault-injection tests compare against it, not a copy), and the
 * scripted good booking flow the runner and self-tests drive.
 */
import {
  MODEL_PROFILES,
  ScriptedLlmClient,
  scriptedText,
  scriptedToolUse,
  type LlmRequest,
  type ScriptedStep,
} from "@sched/agent";
import type { ToolError } from "@sched/contracts";
import { createToolExecutor } from "@sched/tools";
import { FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";

import {
  createTrialEnvironment,
  loadScenarios,
  QueuedPatientSimulator,
  runScenarioTrial,
  type GraderResult,
  type L1Case,
  type Scenario,
  type ToolCallEvent,
  type TranscriptEvent,
  type TrialResult,
} from "../src";

const loaded = loadScenarios();

export function scenario(id: string): Scenario {
  const s = loaded.scenarios.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return s;
}

export function l1Case(id: string): L1Case {
  const c = loaded.l1.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no L1 case ${id}`);
  return c;
}

/** A grader result by name, from a list or a trial. */
export const byName = (
  results: readonly GraderResult[] | { graders: readonly GraderResult[] },
  name: string,
): GraderResult | undefined =>
  ("graders" in results ? results.graders : results).find((r) => r.name === name);

export const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
/** Maria's Dr. Lee dermatology visit, Tue Oct 13 2026, 2:30 PM ET. */
export const MARIA_APPT = "appt_01JBX7Q2M3N4P5R6S7T8V9W0XY";
/** Walter's Dr. Haddad visit (another patient's data, for leak tests). */
export const WALTER_APPT = "appt_01JBX8C4D5E6F7G8H9J0K1M2N3";

let seq = 0;
/** A tool-call event; `ok` and `known` default to true. */
export const call = (name: string, input: unknown, extra: Partial<ToolCallEvent> = {}): ToolCallEvent => ({
  kind: "tool_call",
  turn: 1,
  id: `t_${name}_${String(++seq)}`,
  name,
  known: true,
  input,
  ok: true,
  ...extra,
});

export const patient = (text: string, scriptStep?: number): TranscriptEvent => ({
  kind: "patient",
  turn: 1,
  text,
  ...(scriptStep === undefined ? {} : { scriptStep }),
});

export const assistant = (text: string): TranscriptEvent => ({ kind: "assistant", turn: 1, text });

/** What the production executor answers when a handler throws (`registry.ts`'s INTERNAL error). */
export async function productionInternalError(): Promise<ToolError["error"]> {
  const env = await createTrialEnvironment(scenario("book-derm-next-week-afternoon"));
  const executor = createToolExecutor(
    {
      book_appointment: () => Promise.reject(new Error("handler crashed")),
    },
    { patientId: env.patientId, conversationId: env.conversationId, clock: env.clock, repos: env.repos },
  );
  const result = await executor.execute({
    id: "t1",
    name: "book_appointment",
    input: { slot_id: "slot_okafor_20261015T1800Z", reason: "mole check" },
  });
  if (result.ok) throw new Error("expected the throwing handler to fail");
  return result.error.error;
}

// ---------------------------------------------------------------------------------------------
// book-derm-next-week-afternoon (Maria): Tue/Thu dermatology afternoon next week
// ---------------------------------------------------------------------------------------------

export const CHECK_OKAFOR_THU = scriptedToolUse([
  {
    name: "check_availability",
    input: {
      provider_id: "prov_okafor",
      date_range: { start_date: "2026-10-15", end_date: "2026-10-15" },
      time_of_day: "afternoon",
    },
  },
]);
export const OFFER = scriptedText(
  "Dr. Samuel Okafor has Thursday, October 15, 2026 at 1:30 PM ET or Thursday, October 15, 2026 at 2:00 PM ET. Which one works, and what is the visit for?",
);
export const RESTATE = scriptedText(
  "To confirm: Dr. Samuel Okafor (dermatology), Thursday, October 15, 2026 at 2:00 PM ET, for a mole check. Shall I book it?",
);
export const BOOK_OKAFOR = scriptedToolUse([
  { name: "book_appointment", input: { slot_id: "slot_okafor_20261015T1800Z", reason: "mole check" } },
]);
export const BOOKED = scriptedText(
  "You're booked with Dr. Samuel Okafor on Thursday, October 15, 2026 at 2:00 PM ET at 400 Cedar Ridge Pkwy.",
);
export const BOOKING_PATIENT = [
  "need a derm appt next week, afternoon. tue or thu",
  "the 2:00 one. it's for a mole check",
  "Yes, please book it.",
];

/** The well-behaved flow for the patient above: check, offer, restate, book, confirm. */
export const goodBookingSteps = (): ScriptedStep[] => [CHECK_OKAFOR_THU, OFFER, RESTATE, BOOK_OKAFOR, BOOKED];

/** The model profile scripted runs price against. */
export const SCRIPTED_PROFILE = MODEL_PROFILES["gpt-oss-20b"];

/** Run one scenario trial with scripted model steps and queued patient messages. */
export async function runScripted(
  id: string,
  steps: ScriptedStep[],
  patient: string[],
): Promise<TrialResult> {
  return runScenarioTrial(scenario(id), {
    agent: { llm: new ScriptedLlmClient(steps), profile: SCRIPTED_PROFILE },
    simulator: new QueuedPatientSimulator(patient),
  });
}

/** Names of the graders a trial failed. */
export const failedGraders = (r: TrialResult): string[] =>
  r.graders.filter((g) => g.status === "fail").map((g) => g.name);

/** A request's messages without cache points, to compare conversations across profiles and turns. */
export const withoutCachePoints = (request: LlmRequest) =>
  request.messages.map((m) => ({ ...m, content: m.content.filter((b) => b.type !== "cache_point") }));
