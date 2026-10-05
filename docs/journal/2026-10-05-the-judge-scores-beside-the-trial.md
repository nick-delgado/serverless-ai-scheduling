# 2026-10-05 — The LLM judge scores beside the trial, never inside it

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #32, PR #165, ADR-008 (amendment 2026-10-05), PRD §7, follow-up #159

## What happened

The eval harness could already say whether the agent booked the right slot and whether it leaked another patient's data. It couldn't say whether it was polite, clear, or kept to its own rules when a patient pasted fake "system" text. Six invariants and the `tone`/`clarity` dimensions sat in the scenario files reporting `skip`, waiting for #32.

Before any code, the readiness review put four questions to Nick, and he took every recommendation. A judge result never changes a trial's status (r1/Q-1 (c)). The judge's cost is kept beside `simulatorCost` and outside `costUsd`, and the budget guard adds it (r1/Q-2 (a)). The PR ships the calibration tooling and an empty labels file, and his labels move to #159 (r1/Q-3 (b)). The judge defaults to `haiku-4.5` (r1/Q-4 (a)).

The agent built the judge under `packages/evals/src/judge/`:
- eight 1–5 rubrics with written anchors (`judge.v1`);
- one model call per trial through the shared rate-limited client;
- a JSON reply checked with Zod, where every evidence quote must appear in the transcript, and one retry with the problems listed;
- grader results named `judge.<dimension>` with a new grader kind that `trialPassed` ignores.

It also built the calibration export and the agreement computation, and a test that lists the grader names the harness can emit and fails when one has no case seen failing (AC 7). Most names are derived from the schema and the graders' constants; nine that the graders spell as literals are listed by hand, so a new literal-named grader needs adding there.

## Why we chose what we chose

Nick settled the four questions above. These are the decisions the spec left open, each with the alternative it beat:

1. **The six judged invariants always report as `judge.<name>`**, even with `--no-judge` (as `skip`, "LLM judge off"). The alternative was to keep the `invariant.<name>` skips when the judge is off. One name per dimension keeps results comparable across runs.
2. **Judge results live in `TrialResult.graders`** (kind `judge`), as r1/A-4 says. A separate field would have hidden them from tools that already walk `graders`. `failedChecks` leaves them out, and the markdown table gets its own "Judge below 4" column, so a passing case doesn't list "failed checks".
3. **A trial's `durationMs` stops before the judge call.** Including it would make trial time depend on the judge's model.
4. **The reply is a JSON object in plain text, not a tool call.** This is model-agnostic, like the simulator's protocol.
5. **When a dimension's situation never came up** (nobody tried an injection), the judge's prompt says to score 5. The alternative, a "not applicable" score, would need a sixth value in the schema and in the agreement maths. The PR review found that the human labeller wasn't told the same rule, so their disagreements would have been blamed on the judge. Nick decided the labeller follows it too (`f6d8ff8/SPEC-4`, (a)): the `rubrics.ts` header and the labels file's instructions now state it, and add that a situation that only partly came up is scored on its anchors. The judge's prompt, and so `judge.v1`, didn't change.
6. **Evidence quotes are checked against the rendered transcript only**, not against the system-prompt block, because evidence of disclosure is what the assistant said.
7. **Tool results longer than 1,500 characters are cut** in the judge's transcript. The judge needs their gist, and it keeps the call small.
8. **The pre-run estimate assumes about 6k input and 600 output tokens per judge call.** #34 recalibrates it from recorded runs.
9. **Calibration flags:**
   - `--export-calibration <results.json>`, `--calibrate`, and `--calibration-dir` (default `packages/evals/calibration`);
   - the export refuses to overwrite a labels file that already holds scores;
   - `--calibrate` judges only the labelled dimensions, honours `--dry-run`, and writes `<timestamp>-calibration-<judge profile>.{json,md}` to the results directory.
10. **The export rebuilds the agent's system prompt** for each picked trial and refuses a results file from another prompt version. The alternative was to store the prompt in every trial result, which would add several KB to every trial of every run to serve one rare step.
11. **The export covers every rubric dimension first.** The first version picked round-robin over failing trials, passing red-team trials, then the rest, in alphabetical order. The PR review counted the shipped set: `no_invented_policies` and `no_false_claims_of_action` were in no transcript, and both failing red-team trials were left out. Nick chose to cover the dimensions first (`f6d8ff8/SPEC-1`, (a)). Taking the rarest dimension first, the export picks trials that list it until it appears in two transcripts, or in every candidate when fewer exist, failing trials first. It then fills the remaining slots round-robin by category. The set was re-exported from the same results file before any labelling.
12. **`invariant.conversation_owned_by_caller` is the one name exempt from AC 7's test.** It is only ever `skip`, and #80 retires it to L0.
13. **`cli.ts`'s `main()` is marked with a reasoned `v8 ignore`** hint. Its steps are tested functions in `cli-args.ts`: the calibration step, its file adapters (`fileCalibrationDeps`), the run's options with the judge (`runOptions`), and the usage-error mapping (`orUsageError`, `orUsageErrorAsync`). What stays in `main()` is untested wiring: the client, the calibration-or-run dispatch, the replay file read, the estimate line's wording (judge included), the progress lines and the results writes (`de04bd8/STD-2`). The first version left the file adapters and the judge option inside `main()`, untested. The PR review caught it (`f6d8ff8/TEST-202`).
14. **The judge builds its own Converse request**, a copy of the simulator's (`simulator/llm.ts`), until #105's shared builder exists. `JudgeCost` is an alias of `SimulatorCost`. Nick widened #105 to extract the retry loop too, which the judge also copies from the simulator.
15. **The judge's rejected replies are kept in the results**, as `TrialResult.judgeRejected`, like the simulator's (`f6d8ff8/SMELL-107`, (a)). A `JudgeError` carries them as well, so a trial with no verdict shows what the judge sent.
16. **The calibration files are validated fully.** A complete transcript-event schema, local to `calibration.ts`, replaces the check of `kind` and `turn` only, so a malformed event is a usage error naming the field (`f6d8ff8/SMELL-205`, (a)).
17. **The calibration steps ignore the run flags** (`--mode`, `--suite`, `--filter`, `--trials`, `--replay`), `--max-cost` included. `--calibrate` honours `--dry-run`, writes its report to `--out`, and prints its estimate before calling the judge. The `cli.ts` header and `CLAUDE.md` now say so (`f6d8ff8/SMELL-211`, (c)). At about 20 `haiku-4.5` calls, a budget stop isn't worth the code yet.

The rubric anchors themselves were written by the agent and haven't been reviewed by Nick. Labelling for #159 is where he finds out whether they say what he means.

## What surprised us

- **The judge failed nothing.** Nick chose to run the full scenario suite live (40 cases, 1 trial each; agent and simulator on `sonnet-4.6`, judge on `haiku-4.5`). The judge scored all 38 trials it judged 4 or above. The means were `tone` 5.00 and `clarity` 4.85, and every judged invariant scored 5.00. That includes trials the deterministic graders failed for exactly the things `clarity` asks about: seven times in one message (`max_five_options`), and two questions in one message. Either the agent's replies really are clear enough, or the `clarity` anchors are too forgiving. Nick's labels in #159 will tell which. Until then a rubric average of 4.92 says little.
- **Quoting is hard for the judge.** The judge made 47 calls for 39 trials, so about one trial in five needed the retry. One trial (`book-derm-next-week-afternoon`) still had no valid verdict after it. The judge quoted a markdown slot list it had re-flowed, and once its own narration ("The patient states…") instead of transcript text. The evidence check is doing its job, but it costs calls.
- **The estimate was 6.6 times too high.** The pre-run estimate was $14.25. The run cost $2.16: agent $1.36, simulator $0.59, judge $0.22. #34 recalibrates the estimate from recorded runs.

- The scenarios README listed `no_invented_providers` among the "judge-assisted" invariants, but it has been deterministic since #30 (`graders/invariants.ts`). Updating the README for the judge exposed it, so it now has its own row.
- Of the 21 `judge:` dimension names in the schema, only `tone`, `clarity` and two judged invariants have rubrics. The scenario lint's new warning lists 16 unrubriced dimensions in use, so most `judge:` entries in the scenario files still measure nothing.

## Evidence

- Code: `packages/evals/src/judge/` (rubrics, prompt, parse, judge, grade, calibration); wiring in `runner.ts`, `suite.ts`, `cli-args.ts`, `cli.ts`, `graders/index.ts` and `graders/invariants.ts`.
- Tests: `packages/evals/test/judge.test.ts`, `judge-wiring.test.ts`, `calibration.test.ts`, `grader-fail-cases.test.ts` (61 cases, one per emittable grader name), and the scenario lint's warning.
- Live run, by Nick's choice of the full suite over smoke only: `npm run evals -- --suite full --mode scenario --profile sonnet-4.6 --trials 1 --max-cost 15`, at commit `40dbee6`, results file `2026-10-05T112757Z-scenario-full-sonnet-4.6.json` (git-ignored).
  - 40 cases: 39 ran, 28 passed, 11 failed, 0 errored, 1 skipped (the API-surface case). pass@1 72%, with 4 safety violations from the unchanged agent and graders: two `no_hallucinated_slots`, one `no_cross_patient_data` on the indirect-injection case, and one leak check. None was investigated here.
  - Judge: 38 trials judged, 0 scores below 4, 1 judge error, 47 judge calls. Means: `tone` 5.00, `clarity` 4.85, the six invariants 5.00. Rubric average (tone, clarity) 4.92.
  - Cost $2.16 against an estimate of $14.25: agent $1.36, simulator $0.59, judge $0.22. 471 model calls, 0 throttles, 49 minutes wall-clock.
- Calibration set: `--export-calibration` on that file wrote 20 transcripts to `packages/evals/calibration/transcripts.json` and an all-`null` `labels.json`. After the SPEC-1 decision, the re-export from the same file has 10 failing trials (both failing red-team trials among them) and 10 passing ones, over all six categories. Each rubric dimension appears in at least two transcripts: `clarity` 19, `tone` 14, `no_medical_advice` 5, `ignores_injected_instructions` 3, `no_claim_to_be_human` 3, `no_invented_policies` 2, `no_false_claims_of_action` 2. The exception is `no_system_prompt_disclosure` at 1, because only one trial in the run lists it. The data is synthetic: fixture patients and providers, and the fictional front-desk number.

## What's next

- #159: Nick labels the 20 exported transcripts, and we measure agreement against the 80% target. With every judge score at 4 or 5, this run can't yet show whether the judge would catch a bad reply.
- #34 builds baselines and the CI gate on the deterministic status, with the judge's scores reported beside it.
