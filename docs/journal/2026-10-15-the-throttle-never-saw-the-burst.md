# 2026-10-15 — The security review's burst never reached the throttle: Lambda's concurrency quota of 10 answered first

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #39 (M3-04), PR #275, ADR-009 (2026-10-15 amendment), ADR-010, NFR-004, follow-ups #270, #271, #272, #273

## What happened

The M3 security review audited the running system against ADR-009. The `task-worker` agent did the review, under the answers Nick gave in readiness review r1 on #39. Nick's answers set three limits:
- the PR may fix `infra/stacks/api.yaml` and `services/api` only, and files the rest (Q-1 (a));
- every `*` gets a class (Q-2 (a));
- the checks run on an ephemeral env with a daily cap of 1 (Q-3 (a)).

The agent deployed `sched-sec39-*` from the fix commit and seeded one synthetic patient. It sent one real turn holding a marker string, a second message to hit the cap, and bursts of `POST /api/session`. The summary is [`docs/research/security-review.md`](../research/security-review.md): a row per ADR-009 and NFR-004 line, a table per IAM principal, and 21 findings.

The PR fixes three things in `572297e`:
- **The chat role's table grant:** `…/index/*` becomes `…/index/GSI1`, the only index. Four `Query index=GSI1` calls on `sec39` succeeded under it.
- **The chat role's Bedrock grant:** `anthropic.claude-sonnet-4-6*` loses its trailing `*`. The exact ID was confirmed with `get-foundation-model`, and a live turn completed on it.
- **`errorSummary`:** it now logs an error's message only for AWS SDK errors (Q-5 (b)). Before, any error's message went to CloudWatch, and a tool, a repository or the agent loop can build one from what the patient or the model said.

Template pins cover each change, plus the stage throttle, the cap's default and `/api/chat`'s authorizer, which no test pinned before. The PR's mutate table has the seen-failing evidence. The api stack is deployed to `dev`.

## Why we chose what we chose

The spec left two choices to the agent:
- **Evidence for "no marker in the logs".** Logs Insights skipped records through its index for a `like` filter. It also gave 0 records for the chat group queried alone and 8 when queried with the session group. So the agent read every event with `FilterLogEvents` and grepped the marker locally, with the turn's own log line as a positive control. An Insights count of zero was the alternative, and it proved unreliable on a group a few minutes old.
- **How to characterize the throttle.** Q-3's check, 30 simultaneous calls, failed twice. So the agent also sent paced load (about 12, then 25 requests a second) to separate "the throttle is missing" from "the throttle doesn't bound a simultaneous burst". It didn't change the throttle, because A-6 files abuse limits rather than fixing them.

## What surprised us

- **The burst never met the throttle.** On a cold env, 30 simultaneous session calls got 10 × 200 and 20 × 500, with no 429. The session log group showed exactly 10 cold starts: the account's Lambda concurrent-executions quota is **10**, against an AWS default of 1000. Lambda refused the rest, and API Gateway turned that into a 500. Warm, all 30 got 200. Only paced load got API Gateway's 429: 1 of 40 calls at about 12 a second, and 14 of 60 at about 25 a second. The quota is account-wide, so a burst in one env can starve chat turns in `dev`. It also makes reserved concurrency impossible, because Lambda keeps 10 unreserved.
- **The same regex trap, twice.** The agent's redaction of 12-digit account IDs mangled 13-digit millisecond timestamps in the log exports. The [2026-10-08](2026-10-08-voice-streams-pass-but-the-sdk-hangs-up-early.md) entry describes the same trap. Bounding the pattern to exactly 12 digits fixed it.
- **Drift detection needs a second permission.** `SchedDeployer` has `cloudformation:DetectStackDrift` but not `DetectStackResourceDrift`, so `detect-stack-drift` is denied. The review read the processed templates instead, and the deployed bootstrap template matches the repo's byte for byte.

## Evidence

- Live checks on `sched-sec39-*` (2026-10-15, 18:28–18:30 UTC):
  - The cap: 200, then 429 `RATE_LIMITED` on the second new message.
  - The marker: 0 hits in 395 log events and in 2 X-Ray traces. It appears in `MSG#000000` and `MSG#000001` in DynamoDB, by design.
  - The bursts are as above.
- One turn cost about $0.03: 4 input, 414 output, 5,836 cache-read and 6,582 cache-write tokens on `sonnet-4.6`.
- `dev`: 0 fixture-name hits in 1,074 log records over 14 days. The only `errorMessage` ever logged is a Bedrock `ThrottlingException`'s.
- `aws bedrock get-model-invocation-logging-configuration`: no configuration (logging is off).
- `npm audit`: 0 advisories.
- `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384`: 10.0.

## What's next

- #272: Nick decides on the Lambda concurrency quota and the commit-email setting.
- #273: per-client limits, WAF, a Transcribe cap, and the misleading "10 req/min" throttle comment.
- #270 (the bootstrap and `SchedDeployer` grants, applied by Nick) and #271 (escalation retention).
