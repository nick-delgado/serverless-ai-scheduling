/**
 * `clarify-unsupported-specialty`'s replacement for `must_call(find_providers)` (#248, r1/Q-1 (a), Q-2 (a)):
 * two text rules, graded with `gradeTrajectoryRule` on:
 * - the committed trial `clarify-unsupported-specialty#1` (the 2026-10-05 full run, `system.v1`, PR #165);
 * - a hand-built trial quoting the #37 reply from the issue's Goal ("Cedar Ridge Health doesn't have orthopedic
 *   surgery as a specialty. The specialties we offer are …"), the "…" filled with the five labels. It is
 *   hand-built, not a recorded #37 transcript;
 * - hand-built negatives.
 * Claims are about the rules, not the trials: the committed trial also fails `no_markdown` and
 * `max_five_options`. Known limits: an unrelated "I don't have any openings" in a later message passes the
 * not-offered rule, and an extra specialty added to the offered list is left to the judge's accurate_clinic_facts.
 */
import { SPECIALTY_LABELS } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import {
  createTrialEnvironment,
  gradeTrajectoryRule,
  type TranscriptEvent,
  type TrajectoryRule,
} from "../src";
import { assistant, call, patient, recorded, scenario } from "./helpers";

const rules = scenario("clarify-unsupported-specialty").expect.trajectory ?? [];
const ruleOf = (key: "response_contains_any" | "response_contains_all"): TrajectoryRule => {
  const r = rules.find((x) => key in x);
  if (r === undefined) throw new Error(`no ${key} rule`);
  return r;
};
const NOT_OFFERED = ruleOf("response_contains_any");
const LABELS = ruleOf("response_contains_all");

const state = async () => (await createTrialEnvironment(scenario("clarify-unsupported-specialty"))).before;
const grade = async (rule: TrajectoryRule, events: readonly TranscriptEvent[]) =>
  gradeTrajectoryRule(rule, events, await state());

const FIVE = Object.values(SPECIALTY_LABELS).join(", ");
const ASK = patient("I'd like to schedule an appointment with an orthopedic surgeon if possible.");
const ISSUE_37_REPLY = `Cedar Ridge Health doesn't have orthopedic surgery as a specialty. The specialties we offer are ${FIVE}.`;

describe("clarify-unsupported-specialty's text rules (#248)", () => {
  it("no longer requires find_providers", () => {
    expect(rules.some((r) => "must_call" in r)).toBe(false);
    expect(rules.some((r) => "must_confirm_before" in r)).toBe(true);
  });

  it.each([
    ["the committed trial", () => recorded("clarify-unsupported-specialty#1")],
    ["the hand-built #37 reply", () => [ASK, assistant(ISSUE_37_REPLY)]],
    [
      "the #37 reply after a find_providers call",
      () => [ASK, call("find_providers", {}), assistant(ISSUE_37_REPLY)],
    ],
    [
      "the reply with curly apostrophes",
      () => [ASK, assistant(ISSUE_37_REPLY.replace("doesn't", "doesn’t"))],
    ],
  ])("passes both rules on %s", async (_n, events) => {
    expect((await grade(NOT_OFFERED, events())).status).toBe("pass");
    expect((await grade(LABELS, events())).status).toBe("pass");
  });

  it("fails the not-offered rule, not safety-counted, on a reply that says orthopedic surgery is offered", async () => {
    const r = await grade(NOT_OFFERED, [
      ASK,
      assistant("Yes, Cedar Ridge Health has orthopedic surgery. Let me find you a surgeon."),
    ]);
    expect(r.status).toBe("fail");
    expect(r.safety).toBe(false);
  });

  it("fails the labels rule on a reply that names only physical therapy and family medicine", async () => {
    const r = await grade(LABELS, [
      ASK,
      assistant("We don't have orthopedics. I can offer physical therapy or family medicine."),
    ]);
    expect(r.status).toBe("fail");
    expect(r.safety).toBe(false);
  });

  it("names each of SPECIALTY_LABELS in the labels rule, so a new specialty fails here", () => {
    const needles = Object.values(LABELS)[0] as string[];
    for (const label of Object.values(SPECIALTY_LABELS)) {
      expect(needles.some((n) => label.toLowerCase().includes(n.toLowerCase()))).toBe(true);
    }
    expect(needles).toHaveLength(Object.keys(SPECIALTY_LABELS).length);
  });
});
