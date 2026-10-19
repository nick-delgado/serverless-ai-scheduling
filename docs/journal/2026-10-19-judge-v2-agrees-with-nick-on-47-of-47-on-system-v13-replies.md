# 2026-10-19 — On replies from `system.v13`, `judge.v2` agrees with Nick on 47 of 47 pass/fail calls, and Nick scored none of them below 4

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #296, PR #350, #159, #295, #335, ADR-008, PRD §7

## What happened

#159 measured the judge on 20 transcripts from a `system.v1` run, and four of the six replies Nick failed on clarity were Markdown-heavy. The prompt has asked for plain text since `system.v3`, so we worried that set over-represented one kind of clarity problem and flattered or punished the judge unfairly. #296 re-measures `judge.v2` (`llm:haiku-4.5`, unchanged) on a set from the current prompt.

The task worker (Claude) ran the full scenario suite once, k=1, on `sonnet-4.6` at effort `high`, prompt `system.v13`, `--no-judge`, `--max-cost 6` (results file `2026-10-19T123642Z-scenario-full-sonnet-4.6.json`, run on `2bf6581` and committed with its export as `99cffe1`). The dry-run estimate was $2.24, under the $4.00 line Nick set, and the run came in at $3.32 (simulator $0.62), 48% over the estimate. 36 of 41 runnable cases passed and 5 failed (at least three on the weekday check and one on a missing `time_of_day`; the results file names each). The export took the 5 failing trials and 15 passing ones, 20 transcripts. Nick labelled them on a page built from the export, scoring 47 slots from 1 to 5, and the worker committed his file unchanged (`1ddcdf6`).

## Result

`--calibrate` on `judge.v2`, taken from the committed report's JSON (`ef90f9f`, `packages/evals/calibration/2026-10-19T144842Z-calibration-haiku-4.5.json`):

| | Pass/fail agreement | Exact-score agreement |
|---|---|---|
| Overall | 47/47 (100%) | 40/47 (85.1%) |
| clarity | 18/18 (100%) | 12/18 (66.7%) |
| tone | 14/14 (100%) | 13/14 (92.9%) |
| no_medical_advice | 5/5 (100%) | 5/5 |
| no_claim_to_be_human | 3/3 (100%) | 3/3 |
| ignores_injected_instructions | 2/2 (100%) | 2/2 |
| no_invented_policies | 2/2 (100%) | 2/2 |
| no_false_claims_of_action | 2/2 (100%) | 2/2 |
| no_system_prompt_disclosure | 1/1 (100%) | 1/1 |

The comparison figures, from the committed reports in `packages/evals/calibration/`: on the `system.v1` set `judge.v2` scored 44/49 (89.8%), clarity 14/19, and `judge.v1` scored 42/49 (85.7%), clarity 13/19 (`2026-10-18T112938Z-calibration-haiku-4.5.json`, `2026-10-16T162339Z-calibration-haiku-4.5.json`).

**Do not read 47/47 as the judge getting better.** Nick scored no pair below 4, so the set holds no human fails, and every pass/fail pair is "both pass". The figure says the judge doesn't fail replies Nick passes; it says nothing about whether the judge catches replies Nick would fail. On the `system.v1` set Nick had six clarity scores below 4 and `judge.v1` scored 0 of them below 4, `judge.v2` scored 1 of 6 below 4. On this set Nick has 0 below 4 and the judge has 0 below 4, in every dimension. The 47-pair figure rests on zero human-failed pairs. The clarity gap that #159 found (a judge that passes weak replies) is neither confirmed nor refuted here.

What the exact scores do show: the judge is stricter than Nick on clarity. It gave 4 where Nick gave 5 on six of the 18 clarity pairs, and 5 where Nick gave 4 on one tone pair. Exact agreement on clarity is 66.7%.

## Why we chose what we chose

- **The old set moved to a fixture, not to a subfolder of `calibration/` (Q-1 (b) over (a) and (c)).** `calibration/` now holds only sets measured with the current judge, so the shipped-files test and the rubric-bump rule cover the new set. The 20 `system.v1` trials and Nick's 49 labels live in `packages/evals/test/fixtures/system-v1/`, byte for byte, for the seven test files that read them (`2bf6581`). ADR-008 has an amendment.
- **Report only (Q-3 (a) over (b)).** The figure is above 80%, so the question of revising the rubric didn't arise. We would have only reported a lower figure too, and filed a follow-up.
- **No hand-picked transcripts (A-3).** The selection took every failing trial first, as #159 built it, and there were only five. We left `selectCalibrationTrials` and `CALIBRATION_SIZE` alone, which is why the set has no human fails: the replies that failed on `system.v13` failed grader checks (weekday, a missing argument), not clarity.

## What surprised us

- **Nick passed everything.** The plain-text prompt removed the Markdown that drove four of his six clarity failures. We did not expect all 47 slots to come back at 4 or 5.
- **The judge errored once on the first run.** `book-provider-not-accepting#1` returned no valid verdict in two attempts, because the judge quoted text that wasn't in the transcript. That run's report (`2026-10-19T144559Z-calibration-haiku-4.5.json`) covers 45 pairs and shows 45/45; the re-run, on the same judge version, had no errors and covers 47. The 47-pair run is the figure that counts (A-4); both reports are committed. The two calibrate runs cost $0.164 and $0.148.
- **Thin dimensions.** (`ef90f9f`) `no_system_prompt_disclosure` has 1 pair, and `ignores_injected_instructions`, `no_invented_policies` and `no_false_claims_of_action` have 2 each. Their 100% is not evidence. Clarity (18 pairs) and tone (14) carry the figure.

## Evidence

- Run and export on one commit (`2bf6581`, committed as `99cffe1`, A-1): `source.promptVersion` in `packages/evals/calibration/transcripts.json` is `system.v13`. The results file is git-ignored, so `source.file` there names a session scratchpad path; the lasting copy is `~/.local/state/serverless-ai-scheduling/eval-results/296-recalibrate-judge/2026-10-19T123642Z-scenario-full-sonnet-4.6.json`.
- The set's mix (`99cffe1`): 15 pass and 5 fail trials; dimensions attached to the 20 transcripts are clarity 18, tone 14, no_medical_advice 5, no_claim_to_be_human 3, and the four thin ones above.
- Human scores below 4 (`1ddcdf6`): 0 in every dimension. Judge scores below 4: 0 in every dimension.

## What's next

- #335 gets the figure. A judge that has never been shown a human-failed `system.v13` reply can't be called calibrated on failing ones; a set with real human fails (a prompt that regresses clarity, or hand-built weak replies) is filed as #351.
