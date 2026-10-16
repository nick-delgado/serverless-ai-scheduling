# 2026-10-16 — Eval gate jobs from different PRs now wait in one queue instead of sharing the Bedrock quota

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #304, #305, PR #308, #267, PR #291, #301, ADR-008, FR-041

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
- **`timeout-minutes: 45` stays** (r1/A-5). The docs define it as "the maximum number of minutes to let a job run before GitHub automatically cancels it" and say nothing about time spent pending, so we read it as running time only. The evidence below checks it only as far as a waiting job's step times show.
- **Three runs, no extra Bedrock** (r1/Q-2 (a)). Two throwaway PRs based on this PR's branch, each changing one file no gated path matches, opened seconds apart while this PR's gate job ran.

## Evidence

Pending: the first run of PR #308's `Eval gate` and the two throwaway PRs' runs.

- Seen failing: each pin goes red on its own hand edits to `evals.yml`, and the #305 row on `suite.ts` turns the existing promptVersion test red (the mutate tables in PR #308's body).

## What's next

- Other Bedrock callers on the same quota (`e2e.yml`, local `npm run evals` and `evals:matrix` runs, `dev` chat traffic) don't join the queue (#304's non-goals).
- `packages/evals/src/runner.ts` still calls its default "the interim prompt until #16 lands". That fix is to file.
