# 2026-10-19 — The security review's three account items close: a quota of 1000, an email we keep public, and logging still off

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #272 (M3-04d), #39, #273, PR #352, ADR-009, NFR-004

## What happened

The M3 security review (#39) found three things that live in the AWS account and the git history rather than in the repo's files, and filed them as #272: the account's Lambda concurrent-executions quota was 10 (F-15), commits carry the owner's personal address in their author metadata (F-18), and Bedrock model invocation logging needed to stay off (the A-4 check). Nick did the account side himself. This PR edits the F-15, F-18 and A-4 status cells, and also the "No secrets in the repo" row's pointer to F-18 and the A-4 row's result cell, which go beyond the status cells the issue's owned paths name (listed in the PR body).

- **Quota (F-15).** AWS approved Nick's increase on 2026-10-16, which let #273 reserve 5 concurrent executions for the chat function. On 2026-10-19, `aws service-quotas get-service-quota` for `L-B99A9384` as `sched-dev` still read 1000.0 ([comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/272#issuecomment-6271693288)).
- **Invocation logging (A-4).** `aws bedrock get-model-invocation-logging-configuration` returned no configuration on 2026-10-19, as it did on 2026-10-15, so prompts and replies still go nowhere (same comment). The runbook line AC 3 asks for already exists: `docs/runbooks/aws-setup.md` step 6, from #42, says to leave it off. So AC 3 is met by that line plus this re-check.
- **Author email (F-18).** Nick decided to keep it as it is, public: Decision #272/COMMIT-EMAIL ([comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/272#issuecomment-6272973468)).

## Why we chose what we chose

The spec left the email open, and the choice was between changing nothing and switching future commits to GitHub's no-reply address with its email privacy setting. Nick kept the address public, with no change to either. The decision comment states no reason. The point that switching would only cover new commits, because the existing history keeps the old address, is ours, not Nick's. We record the finding as accepted rather than fixed.

## Evidence

- The quota and logging reads are in the 2026-10-19 comment above; the reads were taken by Nick's session, not this PR's agent.
- Rows changed in `docs/research/security-review.md`: F-15, F-18, the A-4 row, and the "No secrets in the repo" row's pointer to F-18.

## What's next

- Nothing open from the security review's account items. The invocation-logging check is recorded here and on #272, and the runbook's step 6 carries the "leave it off" line, as the issue's third criterion asks.
