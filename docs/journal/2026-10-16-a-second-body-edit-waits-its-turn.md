# 2026-10-16 — A second quick body edit now waits its turn instead of cancelling the first one's run

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #267, PR #291, #265, PR #266, #72

## What happened

PR #266 (#265, B10-2) set `cancel-in-progress: false` on `.github/workflows/pr-evidence.yml`, so a PR body edit stopped cancelling the running `PR evidence` run. But GitHub's default concurrency queue, `queue: single`, keeps only one pending run per group, so a second quick edit still cancelled the first edit's pending run ([the 2026-10-15 entry](2026-10-15-the-pr-body-gets-a-check-of-its-own.md) quotes the docs). Nick had it filed as #267 from PR #266's review (decision `0adf9bf/STD-3` (a)).

An agent (Claude, as #267's task worker) added `queue: max` as a third key under the workflow-level `concurrency:`, after `cancel-in-progress: false`, and pinned it in `scripts/workflows.test.ts` beside the B10-2 pin. GitHub's "Workflow syntax for GitHub Actions" page, under `concurrency`, says that with `queue: max` "up to 100 jobs or workflow runs can be `pending` in the concurrency group", in first-in, first-out order, and that `queue: max` with `cancel-in-progress: true` is a validation error. So a newer run now waits, pending, behind the running one and any earlier pending ones, up to 100 per PR. Each run checks the body of the edit that queued it, so the last run's result is the one for the current body, and each body edit adds one full run of all three jobs. The workflow header and `CLAUDE.md`'s `Seen-failing evidence` bullet now say that, and no longer that a newer run replaces a pending one.

GitHub accepted the key on PR #291's first run ([38921494047](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38921494047)). Two body edits three seconds apart, made while that run was in progress, both queued and both ran to `success` ([38921536064](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38921536064), [38921541156](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38921541156)). Under `queue: single` the first edit's run would have been cancelled when the second arrived.

## Why we chose what we chose

- **Claim nothing about merge blocking** (r1/Q-1 (a), Nick's answer). Whether a cancelled or failed earlier check can block a merge isn't in GitHub's docs. The other option was a throwaway PR on `queue: single` to read `mergeStateStatus` after a cancelled pending run; Nick chose not to add a second PR, since the queueing alone justifies `queue: max`. The one observed case stays one case: on PR #258, check run `115525859567` was cancelled at 20:34:43Z, check run `115525867658` succeeded at 20:35:00Z in another check suite, and the merge at 20:40:17Z came only after the re-run.
- **Workflow level only.** No job-level `concurrency`, and `deploy.yml` and `e2e.yml` keep the default queue (r1/A-1).
- **A new test, not a wider B10-2 test** (r1/A-2), so each setting fails under its own name.

## Evidence

- The running run, from opening PR #291, created 15:08:31Z, jobs 15:08:34Z to 15:08:54Z, `success`: https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38921494047
- Body edit 1 at 15:08:47Z queued a run created 15:08:50Z, `pending` while the first ran; its jobs ran 15:08:57Z to 15:09:18Z, `success`: https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38921536064
- Body edit 2 at 15:08:50Z queued a run created 15:08:52Z, `pending` behind both; its jobs ran 15:09:20Z to 15:09:40Z, `success`: https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38921541156
- `gh run list --workflow pr-evidence.yml` read just after the second edit showed both edit runs `pending` at once, which `queue: single` doesn't allow; none of the three ended `cancelled`.
- Seen failing: setting `queue: single`, and removing the `queue: max` line, each turns the new pin red (the mutate table in PR #291's body, taken at `79e8300`).

## What's next

- #72's next batch record can say whether B10-2's body-edit incidents stop.
