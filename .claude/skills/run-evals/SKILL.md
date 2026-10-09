---
name: run-evals
description: >-
  How to run, read and act on this project's eval harness (packages/evals, ADR-008): the smoke and full
  suites in L1 and scenario mode, cost estimates and the budget guard, results files, the PRD §7 exit table,
  the committed baselines and how to update them, the model × effort matrix (npm run evals:matrix), and the
  CI eval gate (the "Eval gate" check, .github/workflows/evals.yml, scripts/eval-gate.ts). Use it whenever
  you change the agent, its prompt, tools, model profiles, contracts or the harness and need eval numbers
  for the PR, when the Eval gate fails or reports a regression, when asked to run evals, compare models,
  update a baseline, compute the exit metrics, or estimate what a run costs, even if the user just says
  "run the smoke suite" or "why is the eval check red".
---

# Running the evals

Live runs call Amazon Bedrock and cost real money. Every command below that calls a model prints its
estimate first; run it with `--dry-run` before the live run, pass `--max-cost`, and say what a run will cost
before running anything beyond what you were approved (`CLAUDE.md`, AWS rules). Use the `sched-dev` AWS
profile; if its SSO session expired, ask Nick to run `aws sso login --profile sched-dev`.

## 1. The two modes and two suites

| | L1 (`--mode l1`, the default) | Scenario (`--mode scenario`) |
|---|---|---|
| What | One model call on a fixed conversation; the next action is graded | A whole conversation: an LLM plays the patient (simulator, `sonnet-4.6`), the real agent loop runs over in-memory repos, deterministic graders check the end state, an LLM judge (`haiku-4.5`) scores tone and clarity beside them |
| Smoke cost on `sonnet-4.6`, k=1 | ≈ $0.06 | ≈ $0.36 with the judge (estimate ≈ $0.50) |
| Counts towards | a diagnostic | PRD §7 task success and reliability |

`--suite smoke` is the cases tagged `smoke` (8 per mode); `--suite full` is everything. A full scenario run
at k=3 is several dollars and about two hours at the 10 RPM Claude quota; don't start one without approval.

```bash
AWS_PROFILE=sched-dev npm run evals -- --suite smoke --mode l1 --trials 1 --profile sonnet-4.6 --max-cost 1 --dry-run
AWS_PROFILE=sched-dev npm run evals -- --suite smoke --mode l1 --trials 1 --profile sonnet-4.6 --max-cost 1
AWS_PROFILE=sched-dev npm run evals -- --suite smoke --mode scenario --trials 1 --profile sonnet-4.6 --max-cost 1
```

Narrowing: `--filter <substring>[,…]` (any ID containing one), `--ids <id>[,…]` (exactly these IDs; an
unknown ID is a usage error). `--replay <results.json>` replays a scenario run's recorded patient turns
(no simulator calls; the judge still runs). `--no-judge` turns the judge off.

## 2. Reading a run

Each live run writes `packages/evals/results/<timestamp>-<mode>-<suite>-<profile>.{json,md}` (git-ignored)
and a copy outside the checkout (`~/.local/state/serverless-ai-scheduling/eval-results/<checkout>/`). The
markdown has:

- cases, pass@1, pass^k, safety violations (target 0; which checks count is in ADR-008), budget stops;
- latency and cost: `costUsd` is agent plus simulator; the judge's cost is shown apart;
- scenario mode: the judge line; **conversations** (completed = ended `goal_achieved` or `escalated`; turns
  per completed conversation; agent cost per completed conversation = the agent's share over every trial ÷
  completed trials); the **core categories** line (task success and reliability over book, reschedule,
  availability, escalate, clarify); and a **per-scenario drill-down** with each trial's stop reason, turns,
  agent cost, failed checks and judge scores;
- both modes: the **emergency** cases (tagged `emergency`) and whether each passed every trial.

The process exits 1 on a safety violation or an errored case, 2 on a usage error.

## 3. The PRD §7 exit table

```bash
npm run evals -- --exit-report <l1-results.json> <scenario-results.json>
```

No model calls. The files are told apart by their `mode`. It writes `<out>/<stamp>-exit-<profile>.{json,md}`
with each §7 metric, its target and a verdict. The exit runs are `--suite full --trials 3` in both modes with
the simulator on `sonnet-4.6` and no budget stop; any other pair is still tabled, headed "Not an exit run"
with the reasons. Judge–human agreement (`--calibrate`) and NFR-001 are measured elsewhere.

## 4. Baselines

`packages/evals/baselines/<profile>.json` holds the smoke suite at k=1 in both modes: each case's status,
the model ID, prompt version, date, passed count, safety violations and agent-share cost. Only
`sonnet-4.6.json` exists (#34); other profiles' files are #37's.

To update it, run both smoke modes live, then promote the two results files (no model call):

```bash
npm run evals -- --update-baseline packages/evals/results/<…-l1-smoke-sonnet-4.6>.json packages/evals/results/<…-scenario-smoke-sonnet-4.6>.json
```

It refuses another suite, k≠1, two profiles or a budget-stopped case. Commit the file in the PR that
changes behaviour, and say why in the PR: the gate reads the baseline from the PR's own merge commit, so a
PR that lowers it sets its own bar, and reviewers must see that in the diff.

## 5. The CI eval gate (`Eval gate`)

`.github/workflows/evals.yml` runs on every PR; `scripts/eval-gate.ts` makes every decision.

1. **plan:** if the PR changes none of `packages/agent/**`, `packages/tools/**`, the non-test files under
   `packages/contracts/src/`, `packages/evals/src/**`, `packages/evals/scenarios/**`,
   `packages/evals/baselines/**` or `.github/workflows/evals.yml`, it passes without calling Bedrock. A
   gated change on a run without `AWS_EVAL_ROLE_ARN` (a fork's or Dependabot's PR) fails closed.
2. It prints the OIDC subject, assumes `sched-github-evals` (Bedrock on `sonnet-4.6` and `haiku-4.5` only),
   and runs both smoke modes at k=1 on `sonnet-4.6` with `--max-cost 1` each.
3. It re-runs exactly the errored cases once (`--ids`).
4. **verdict:** it fails on any safety violation (both attempts), **more than one** case that passed in the
   baseline and doesn't pass now in a mode, a budget-stopped case, or a case still `error`. The judge never
   decides. The job summary has the comparison table and both runs' summaries; the results JSONs are an
   artifact (`eval-gate-results`).

When it's red: open the job summary, find the regressed cases, download the artifact, and read the case's
drill-down and failed checks. A grader false positive is a grader bug to fix (with a test), not a baseline
to lower. A real regression is fixed in the PR, or Nick accepts it with a decision line on the issue.

Run the same steps locally on saved results:

```bash
mkdir -p "$TMPDIR/gate/l1" "$TMPDIR/gate/scenario"   # one results .json (and its .md) in each
npx tsx scripts/eval-gate.ts errored "$TMPDIR/gate/l1"
npx tsx scripts/eval-gate.ts verdict --results "$TMPDIR/gate" --baseline packages/evals/baselines/sonnet-4.6.json
PR_BASE=origin/main npx tsx scripts/eval-gate.ts plan   # which gated paths this branch changes
```

## 6. The model matrix (FR-042)

```bash
npm run evals:matrix -- --dry-run                      # each cell's estimate and the total (about $72 for all 14 cells)
npm run evals:matrix -- --cells haiku-4.5,gpt-oss-20b  # asks y/N on a terminal; --yes skips it; off a terminal it needs --yes
```

Cells are the six entitled profiles, plus `<profile>@<effort>` (`low`, `medium`, `high`) where a profile has
a reasoning switch (Sonnet 4.6, Nova 2 Lite, gpt-oss); a profile's default level is the plain cell. Each cell
runs the two §7 exit runs, writes their results, and builds its exit table; the matrix writes
`<stamp>-matrix.{md,json}` comparing the §7 metrics, agent cost per completed conversation, p95 latency and
wall-clock. `--max-cost` caps the whole matrix (default 1.5× the estimate). The estimate doesn't model
reasoning tokens, so effort cells estimate alike. The live matrix is #37's; don't run it without Nick's
go-ahead.

## 7. Cost estimates

`estimateRunCost` (`packages/evals/src/cli-args.ts`) was recalibrated in #34 from recorded runs, and
`packages/evals/test/estimate-calibration.test.ts` pins it between 1.0× and 1.5× of them. If a run's actual
cost moves far from its estimate (a prompt or model change), update the constants and that test from the
new run's recorded usage.
