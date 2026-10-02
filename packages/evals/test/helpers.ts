/**
 * Shared test fixtures: case lookups, grader-result lookup, transcript event builders, fixture ids, and
 * the production INTERNAL tool error (so fault-injection tests compare against it, not a copy).
 */
import type { ToolError } from "@sched/contracts";
import { createToolExecutor } from "@sched/tools";
import { FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";

import {
  createTrialEnvironment,
  loadScenarios,
  type GraderResult,
  type L1Case,
  type Scenario,
  type ToolCallEvent,
  type TranscriptEvent,
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
