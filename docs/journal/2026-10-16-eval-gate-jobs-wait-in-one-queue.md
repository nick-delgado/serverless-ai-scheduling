# 2026-10-16 — Eval gate jobs from different PRs now wait in one queue instead of sharing the Bedrock quota

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #304, #305, PR #308, #312, #267, PR #291, #301, ADR-008, FR-041

## What happened

`evals.yml` serialized `Eval gate` runs only within one PR (`group: evals-${{ github.event.pull_request.number }}`, `cancel-in-progress: true`), so runs from different PRs overlapped and shared the account's per-model request quota. Nick raised it on 2026-10-16 after two overlaps that day, and had it filed as #304. The issue's table measured them:

- #159's run [38933802479](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38933802479) (16:40–16:58) and PR #292's (#282) run [38934082494](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38934082494) (16:42–16:58) overlapped for about 16 min, and #159's took about 18 min against the usual 10–11.
- PR #302's (#299) run [38958895946](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38958895946) (19:59–20:10) and #300's run [38959749845](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38959749845) (from 20:05) overlapped for about 5 min. The first logged 8 throttled retries in scenario mode (20:07:56–20:10:03), the second 13, all recovered.

A throttled retry that never recovers turns a case into `error`, which costs a re-run, and throttling shifts the run's timing and the simulator's conversation. Both PR #292's and PR #302's runs also regressed `book-derm-next-week-afternoon` (#301), but we don't claim the overlaps caused that: #301 tracks the case on its own.

An agent (Claude, as #304's task worker) added a job-level `concurrency` block to the `gate` job, beside the per-PR workflow group: a constant group, `eval-gate-bedrock`, with `cancel-in-progress: false` and `queue: max`. GitHub's "Workflow syntax for GitHub Actions" page, under `concurrency`, says `queue: max` lets "up to 100 jobs or workflow runs" be `pending` in the group, and that the default, `queue: single`, cancels and replaces an existing pending one; [the #267 entry](2026-10-16-a-second-body-edit-waits-its-turn.md) showed that on `pr-evidence.yml`. So at most one gate job runs at a time across the repository, and a later one waits behind the running one and any earlier pending ones. The workflow-level group still lets a new push cancel the PR's own older run. Two new pins in `scripts/eval-gate.test.ts` hold both blocks. The `evals.yml` header and `CLAUDE.md`'s `Eval gate` bullet now say how gate jobs queue, and the comment that said "one group per repository would drop another PR's pending run" is gone.

The PR also carries #305: `packages/evals/src/suite.ts` called the default system prompt "the interim prompt", and now names `buildSystemPrompt` from `@sched/agent` with no version.

## Why we chose what we chose

- **Every gate job queues, not only the ones that call Bedrock** (r1/Q-1 (a), Nick's answer). GitHub applies a job's `concurrency` before its first step, and the decision to call Bedrock is a step in the same job. Queuing only the Bedrock runs meant splitting the job into a plan job and a gate job, an ADR-008 amendment and test rewrites. The cost of one job is waiting time on PRs that change no gated path, never Bedrock spend; they then finish in about a minute.
- **A job-level block, not a workflow-level one.** A workflow-level constant group can't also keep the per-PR cancel: one `concurrency` block has one group.
- **`queue: max`, never the default.** `queue: single` keeps one pending job and cancels the one before it, which would drop a third PR's run (r1/A-1).
- **`timeout-minutes: 45` stays** (r1/A-5). The docs define it as "the maximum number of minutes to let a job run before GitHub automatically cancels it" and say nothing about time spent pending, so we read it as running time only.
- **Three runs, no extra Bedrock** (r1/Q-2 (a)). Two throwaway PRs based on this PR's branch, each changing one file no gated path matches, opened seconds apart while this PR's gate job ran.

## Evidence

GitHub accepted job-level `queue: max` beside the workflow-level `cancel-in-progress: true`: PR #308's first `Eval gate` job started 3 s after its run was created, with no validation error. While it ran, the agent opened two throwaway PRs (#309, #310), 3 s apart, each based on PR #308's branch and adding one file under `docs/`. Both gate jobs ([38975656723](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38975656723), [38975660724](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38975660724)) showed `pending` at 22:25:56Z, both waited, and each started only after the job ahead of it completed:

| Run | Created | Job's first step | Job completed | Conclusion |
|---|---|---|---|---|
| PR #308, [38975630140](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38975630140) | 22:25:10Z | 22:25:14Z | 22:36:05Z | `success` |
| PR #309, [38975656723](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38975656723) | 22:25:26Z | 22:36:08Z | 22:36:28Z | `success` |
| PR #310, [38975660724](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38975660724) | 22:25:29Z | 22:36:31Z | 22:36:55Z | `success` |

- The first throwaway job ([38975656723](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38975656723)) waited about 10 min 40 s and then ran for 20 s; neither throwaway job was `cancelled`, so the queue kept two pending jobs at once, which `queue: single` doesn't allow. Each throwaway's plan step logged "No agent, tools, contracts or eval-harness path changed: the gate passes without calling Bedrock." The PRs were closed unmerged and their branches deleted.
- PR #308's own run ([38975630140](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38975630140)) passed the gate: L1 passed 8 of 8 and scenario 8 of 8, no regression and no safety violation, and its log shows 0 throttled calls in both modes.
- The run doesn't show what a new push does to a job waiting in the queue (A-6), so the docs say only that a new push still cancels the PR's older run. A 10 min 40 s wait is far from `timeout-minutes: 45`, so it doesn't test A-5 either ([38975656723](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38975656723)).
- Seen failing: each pin goes red on its own hand edits to `evals.yml`, and the #305 row on `suite.ts` turns the existing promptVersion test red (the mutate tables in PR #308's body).

## What's next

- Other Bedrock callers on the same quota (`e2e.yml`, local `npm run evals` and `evals:matrix` runs, `dev` chat traffic) don't join the queue (#304's non-goals).
- `packages/evals/src/runner.ts` still calls its default "the interim prompt until #16 lands". #312 tracks that fix, and #284's PR #311 carries it. **Later (2026-10-16):** PR #311 fixed it in `bdf5e29`: the comment now names the current system prompt (`buildSystemPrompt` from `@sched/agent`).
