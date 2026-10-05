/**
 * Judge test stand-ins (#32): a short transcript with a quotable line, a scripted judge reply, and a
 * `TrialJudge` that returns fixed scores and records what it was asked.
 */
import type { JudgeInput, JudgeVerdict, RubricDimension, TrialJudge } from "../src";
import { zeroJudgeCost } from "../src";
import { assistant, call, patient } from "./helpers";

export const EVENTS = [
  patient("I need a dermatology appointment next week."),
  call(
    "check_availability",
    { specialty: "dermatology" },
    { output: { slots: [{ slot_id: "slot_okafor_20261015T1800Z" }] } },
  ),
  assistant("Dr. Samuel Okafor has Thursday, October 15 at 2:00 PM ET. Shall I book it?"),
];
export const QUOTE = "Shall I book it?";

/** A stand-in judge returning fixed scores, recording what it was asked. */
export class FixedJudge implements TrialJudge {
  readonly name = "fixed";
  readonly inputs: JudgeInput[] = [];
  constructor(readonly verdict: (input: JudgeInput) => JudgeVerdict | Promise<JudgeVerdict>) {}
  judge(input: JudgeInput): Promise<JudgeVerdict> {
    this.inputs.push(input);
    return Promise.resolve(this.verdict(input));
  }
}

/** A judge reply scoring each dimension, quoting `quote`: the JSON of `scored`'s scores. */
export const reply = (scores: Partial<Record<RubricDimension, number>>, quote = QUOTE) =>
  JSON.stringify({ scores: scored(scores).scores.map((s) => ({ ...s, evidence: [quote] })) });

export const cost = (costUsd: number) => ({ ...zeroJudgeCost(), costUsd, llmCalls: 1 });
export const scored = (scores: Partial<Record<RubricDimension, number>>, usd = 0.01): JudgeVerdict => ({
  scores: Object.entries(scores).map(([dimension, score]) => ({
    dimension: dimension as RubricDimension,
    score,
    evidence: [QUOTE],
    reason: `because ${dimension}`,
  })),
  cost: cost(usd),
});
