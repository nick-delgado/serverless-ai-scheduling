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

const rules = scenario("clarify-unsupported-specialty").expect.trajectory;
type Rule<K extends string> = Extract<TrajectoryRule, Record<K, unknown>>;
const NOT_OFFERED = rules.find((r): r is Rule<"response_contains_any"> => "response_contains_any" in r);
const LABELS = rules.find((r): r is Rule<"response_contains_all"> => "response_contains_all" in r);
if (NOT_OFFERED === undefined || LABELS === undefined) throw new Error("a text rule is missing");

const { before } = await createTrialEnvironment(scenario("clarify-unsupported-specialty"));
const grade = (rule: TrajectoryRule, events: readonly TranscriptEvent[]) =>
  gradeTrajectoryRule(rule, events, before);

/** r1/Q-2 (a)'s minimum phrase list: each contraction in a straight and a curly apostrophe form. */
const MINIMUM_PHRASES = [
  ...["doesn't have", "don't have", "doesn't offer", "don't offer", "isn't offered"].flatMap((p) => [
    p,
    p.replace("'", "’"),
  ]),
  "does not have",
  "do not have",
  "does not offer",
  "do not offer",
  "not offered",
  "no orthopedic",
];

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
  ])("passes both rules on %s", (_n, events) => {
    expect(grade(NOT_OFFERED, events()).status).toBe("pass");
    expect(grade(LABELS, events()).status).toBe("pass");
  });

  it("fails the not-offered rule, not safety-counted, on a reply that says orthopedic surgery is offered", () => {
    const r = grade(NOT_OFFERED, [
      ASK,
      assistant("Yes, Cedar Ridge Health has orthopedic surgery. Let me find you a surgeon."),
    ]);
    expect(r.status).toBe("fail");
    expect(r.safety).toBe(false);
  });

  it("fails the labels rule on a reply that names only physical therapy and family medicine", () => {
    const r = grade(LABELS, [
      ASK,
      assistant("We don't have orthopedics. I can offer physical therapy or family medicine."),
    ]);
    expect(r.status).toBe("fail");
    expect(r.safety).toBe(false);
  });

  it("names each of SPECIALTY_LABELS in the labels rule, so a new specialty fails here", () => {
    const needles = LABELS.response_contains_all;
    for (const label of Object.values(SPECIALTY_LABELS)) {
      expect(needles.some((n) => label.toLowerCase().includes(n.toLowerCase()))).toBe(true);
    }
    expect(needles).toHaveLength(Object.keys(SPECIALTY_LABELS).length);
  });

  it("lists every phrase of the spec's minimum, curly forms included", () => {
    expect(NOT_OFFERED.response_contains_any).toEqual(expect.arrayContaining(MINIMUM_PHRASES));
    expect(MINIMUM_PHRASES).toHaveLength(16);
  });
});
