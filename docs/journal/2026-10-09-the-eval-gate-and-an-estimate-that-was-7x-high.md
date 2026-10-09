# 2026-10-09 — The eval gate compares cases, not counts, and our cost estimate was 7x high

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #34, PR #229, ADR-008 ([2026-10-09 amendment](../adr/0008-evaluation-strategy.md#amendment-2026-10-09-reports-baselines-the-matrix-and-the-ci-gate-34)), FR-040, FR-041, FR-042, PRD §7, #37, #41, #178

## What happened

#34 turns the harness's raw results into decisions. The agent built it against the issue's readiness answers, which Nick settled before work started (r1/Q-1 to Q-7, A-1 to A-12):

- **Reports.** A scenario run now reports agent cost per completed conversation, turns per completed conversation, its half of the PRD §7 exit metrics (core-category task success and reliability, its emergency cases), and a per-scenario drill-down. `npm run evals -- --exit-report <l1.json> <scenario.json>` builds the whole §7 table from two saved results files, with no model calls.
- **Baselines.** `packages/evals/baselines/sonnet-4.6.json` holds each smoke case's status in each mode. `--update-baseline` promotes two results files to it.
- **The gate.** `.github/workflows/evals.yml` ("Eval gate") runs on every PR. `scripts/eval-gate.ts` decides whether a gated path changed, re-runs errored cases once, and compares each mode with the baseline case by case.
- **The matrix.** `npm run evals:matrix` runs 14 cells: the six entitled profiles, plus effort levels where a profile has a reasoning switch. The agent only dry-ran it ($72 estimated); the live run is #37's.

The seed baseline came from two live smoke runs on this branch on 2026-10-09: L1 8/8 passed at $0.057, and scenario 8/8 passed at $0.317 plus $0.043 for the judge. Both had 0 safety violations. Agent cost per completed conversation was $0.031, against NFR-003's $0.25 ceiling.

## Why we chose what we chose

Nick's decisions are in the ADR amendment. These are the ones the spec left open; the agent made them, and Nick can overturn any of them on the PR:

- **What the estimate's ratio is measured against.** "Recorded cost" in r1/A-9 is the run's total, the judge included, because the estimate includes the judge. The scenario estimate is pinned between 1.0x and 1.5x of the two 2026-10-07 smoke runs and of PR #165's full run. The L1 estimate was 2.65x high, past A-9's 2x threshold, so we recalibrated it too. It now models the system-and-tools cache prefix: written once per run, read afterwards. It also adds ~500 uncached tokens a call that the request's bytes / 4 missed. We checked it against the cold-cache L1 runs. One warm-cache run ($0.040) is 1.55x, which the test doesn't pin. The alternative, a flat 2x safety factor, would hide the next drift.
- **The judge rubric average with one dimension scored.** r1/A-11 says the mean of the two means. When only `tone` or only `clarity` was scored, the average is that one mean. We rejected reporting n/a, because a run that scored one dimension still has a meaningful average.
- **The matrix budget.** `--max-cost` caps the whole matrix, with a default of 1.5x the estimate. Each run's budget guard gets whatever is left. We rejected a per-run cap: with 28 runs, it's a number nobody can reason about.
- **The gate's credentials message.** For a fork, the remedy is to push the branch to this repository. For Dependabot, it's a push of Nick's own. GitHub's documentation says a re-run keeps the first run's privileges, so a re-run alone doesn't help. Its pages don't state that a person's push gives the run secrets: r1/Q-2's "(verify first)" is still open for Dependabot. On the review of PR #229, Nick accepted both remedies as shipped (91c9fc5/SPEC-3 (a)): the first Dependabot PR that touches a gated path confirms the Dependabot one, and its result goes in the journal.
- **Baseline cost precision.** We round the agent-share cost to a millionth of a dollar, so float noise doesn't churn the committed file. We rejected storing the raw sum, whose last digits change with the order of the trials.
- **Exit-table rows per category** are breakdown rows. `exitMet` reads only the headline rows, so a category with no runnable case shows n/a without failing the run on its own. We rejected requiring each category to meet 90% as well, which PRD §7 doesn't ask for: its target is the mean over the core categories.
- **A verdict at exactly its target** (from the review of `cddafdb`, TEST-101) is met. The comparison allows a float error of `EXIT_TOLERANCE` (1e-9), because a mean of thirds can come out at 0.8999999999999998 for an exact 90%. We rejected comparing on raw trial counts, since task success is a mean of per-case rates, not a pooled count.

## What surprised us

The cost estimate was off in a way the code made easy to miss. It charged 3 agent calls per turn at 4k uncached input tokens. The recorded runs made 1.5 calls a turn, and almost all of each prompt was a cache read at a tenth of the input price. The smoke estimate fell from $2.73 to $0.50, against $0.34 and $0.39 actually spent: from about 7x high to 1.3x–1.5x. For the full suite at k=1 it fell from $14.25 to $2.46, against $2.16 spent. A budget guard sized from the old estimate would have let a run spend several times what anyone expected.

## Evidence

- Live runs (this branch, `sonnet-4.6`, prompt `system.v1`, results under `~/.local/state/serverless-ai-scheduling/eval-results/34-eval-gate/`):
  - `2026-10-09T111801Z-l1-smoke`: 8/8, 0 safety violations, $0.0566 (estimate $0.0615);
  - `2026-10-09T111857Z-scenario-smoke`: 8/8, 0 safety violations, $0.3169 plus judge $0.0430 (estimate $0.4958); 86 calls, 0 throttles.
- `packages/evals/test/estimate-calibration.test.ts` pins the estimate against the recorded runs.
- The gate's verdict on those two files, run locally against the new baseline, passed with 0 regressions in each mode.
- The gate's runs on this PR, each on `sonnet-4.6` with the judge on `haiku-4.5`:
  - [run 37930953931](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/37930953931), at `ac5aeb3`, passed. The credentials step succeeded with the subject `…:pull_request:job_workflow_ref:nick-delgado/serverless-ai-scheduling/.github/workflows/evals.yml@refs/pull/229/merge`, the eval role's string with the PR number. L1 was 8/8. Scenario was 7/8 with 0 safety violations: `book-derm-next-week-afternoon` failed `invariant.times_in_clinic_tz_with_weekday`, the one regression a mode may have. It cost $0.0405, $0.3208 and $0.0417 for the judge.
  - [run 37935466134](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/37935466134), at `91c9fc5` after merging `main`, passed. L1 was 8/8. Scenario was 7/8: the same case failed a different check, `invariant.max_five_options`. It cost $0.0574, $0.3511 and $0.0435 for the judge.
  - The same case failed both runs on different formatting checks after passing in the seed run, so at k=1 it looks flaky. Neither failure was a safety violation.
- Seen failing: the PR's `npm run mutate` tables.

## What's next

- The first Dependabot PR that touches a gated path shows whether a push of Nick's own gives its run credentials (91c9fc5/SPEC-3 (a)).
- #37 runs the matrix live and writes the other profiles' baselines.
- #178's `no_hallucinated_slots` false positive can still fail the gate on `book-derm-next-week-afternoon` until it's fixed.
