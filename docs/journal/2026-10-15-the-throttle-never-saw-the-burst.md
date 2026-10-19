# 2026-10-15 — The security review's burst never reached the throttle: Lambda's concurrency quota of 10 answered first

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #39 (M3-04), PR #275, ADR-009 (2026-10-15 amendment), ADR-010, NFR-004, follow-ups #270, #271, #272, #273

## What happened

We ran the M3 security review against ADR-009 under the answers Nick gave in readiness review r1 on #39. The `task-worker` agent did the review and the fixes; Nick set the limits:
- the PR may fix `infra/stacks/api.yaml` and `services/api` only, and files the rest (Q-1 (a));
- every `*` gets a class (Q-2 (a));
- the checks run on an ephemeral env with a daily cap of 1 (Q-3 (a)).

We deployed `sched-sec39-*` from the fix commit and seeded one synthetic patient. We sent one real turn holding a marker string, a second message to hit the cap, and bursts of `POST /api/session`. With Nick's approval, the orchestrating session tore the env down the same day. The summary is [`docs/research/security-review.md`](../research/security-review.md): a row per ADR-009 and NFR-004 line, a table per IAM principal, and the findings list.

The PR fixes three things in `572297e`:
- **The chat role's table grant:** `…/index/*` becomes `…/index/GSI1`, the only index. Four `Query index=GSI1` calls on `sec39` succeeded under it.
- **The chat role's Bedrock grant:** `anthropic.claude-sonnet-4-6*` loses its trailing `*`. We confirmed the exact ID with `get-foundation-model`, and a live turn completed on it.
- **`errorSummary`:** it now logs an error's message only for AWS SDK errors (Q-5 (b)). Before, any error's message went to CloudWatch, and a tool, a repository or the agent loop can build one from what the patient or the model said.

Template pins cover each change, plus the stage throttle, the cap's default and the API's authorizer, which no test pinned before. The PR's mutate table has the seen-failing evidence. The api stack is deployed to `dev`.

PR #275's review then found that the IAM tables gave the evals role's `refs/pull/*/merge` trust wildcard a reason that was true only of the e2e role. We split the CI roles into one table each, so every trust policy carries its own class. Nick decided (`1517fd9/SPEC-4` (a)) that the boundary's other ceiling-only actions count as a finding too, so they joined #270.

## Why we chose what we chose

The spec left one choice to us:
- **How to characterize the throttle.** Q-3's check, 30 simultaneous calls, failed twice. So we also sent paced load (about 12, then 25 requests a second) to separate "the throttle is missing" from "the throttle doesn't bound a simultaneous burst". We didn't change the throttle, because A-6 files abuse limits rather than fixing them.

One step departs from r1/Q-3, which named Logs Insights for the marker search:
- **Evidence for "no marker in the logs".** Logs Insights skipped records through its index for a `like` filter. It also gave 0 records for the chat group queried alone and 8 when queried with the session group. So we read every event with `FilterLogEvents` and grepped the marker locally, with the turn's own log line as a positive control. The Insights queries ran too and found no hit, but a zero from them proved unreliable on a group a few minutes old. On `dev`, the fixture-name search stayed in Logs Insights, as Q-3 says.

## What surprised us

- **The burst never met the throttle.** On a cold env, 30 simultaneous session calls got 10 × 200 and 20 × 500, with no 429. The session log group showed exactly 10 cold starts: the account's Lambda concurrent-executions quota is **10**, against an AWS default of 1000. Lambda refused the rest, and API Gateway turned that into a 500. Warm, all 30 got 200. Only paced load got API Gateway's 429: 1 of 40 calls at about 12 a second, and 14 of 60 at about 25 a second. The quota is account-wide, so a burst in one env can starve chat turns in `dev`. It also makes reserved concurrency impossible, because Lambda keeps 10 unreserved. **Later (2026-10-16):** Lambda keeps 100 unreserved, not 10 (the Lambda docs, "Configuring reserved concurrency"); see [Five chat turns at once per env](2026-10-16-five-chat-turns-at-once.md).
- **The same regex trap, twice.** Our redaction of 12-digit account IDs mangled 13-digit millisecond timestamps in the log exports. The [2026-10-08](2026-10-08-voice-streams-pass-but-the-sdk-hangs-up-early.md) entry describes the same trap. Bounding the pattern to exactly 12 digits fixed it.
- **Drift detection needs a second permission.** `SchedDeployer` has `cloudformation:DetectStackDrift` but not `DetectStackResourceDrift`, so `detect-stack-drift` is denied. We read the processed templates instead. The deployed bootstrap template matches the repo's, apart from one em dash stored as `?`.

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

- #272: Nick decides on the Lambda concurrency quota and the commit-email setting. **Later (2026-10-19):** #272 closed, see [the #272 entry](2026-10-19-the-security-reviews-account-items-close-two-checked-one-accepted.md).
- #273: per-client limits, WAF, a Transcribe cap, and the misleading "10 req/min" throttle comment. **Later (2026-10-16):** the comment is fixed, the chat function reserves 5, and Nick accepted the rest; see [Five chat turns at once per env](2026-10-16-five-chat-turns-at-once.md).
- #270 (the bootstrap and `SchedDeployer` grants, applied by Nick) and #271 (escalation retention). **Later (2026-10-19):** #270's first PR narrowed every grant but the execution role's; see [The boundary keeps only what a workload role grants](2026-10-19-the-boundary-keeps-only-what-a-workload-role-grants.md).
- #42: the runbook still says `SchedDeployer` calls `bedrock-mantle:CreateInference` (F-19). **Later (2026-10-16):** step 3 now names the four Bedrock actions the policy grants, and step 6 says to leave model invocation logging off; see [A new env from the runbook alone](2026-10-16-a-new-env-from-the-runbook-alone.md). **Later (2026-10-19):** the policy grants two Bedrock actions now, not four (the Mantle pair is dropped); see [The boundary keeps only what a workload role grants](2026-10-19-the-boundary-keeps-only-what-a-workload-role-grants.md).
