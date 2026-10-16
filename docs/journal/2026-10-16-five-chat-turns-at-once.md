# 2026-10-16 — Five chat turns at once per env: the reservation turns the sixth into a 500 the SPA already retries

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #273 (M3-04c), PR #298, #39, #272, ADR-009, NFR-004

## What happened

The M3 security review (#39) left six abuse findings open for #273: a misleading throttle comment (F-11), a stage-wide rather than per-client throttle (F-12), no reserved concurrency for the chat function (F-14), the 500 a Lambda throttle produces (F-15), no Transcribe cap (F-16) and no WAF (F-17). Nick answered the readiness review on #273: accept the stage-wide throttle and the missing WAF (r1/Q-1 (a)), accept the missing Transcribe cap (r1/Q-3 (a)), and reserve concurrency for chat once #272 raised the account's Lambda quota (r1/Q-2 (c)). #272 raised it from 10 to 1000 the same morning, so the reservation went in now. He also decided that none of this needs an ADR change (r1/A-8): the acceptances live in the security review's status rows and on #273.

The `task-worker` agent made the change in `7edb209`:
- **The throttle's comment** stops citing "the account quota is 10 req/min", which was the Bedrock quota for `sonnet-4.6`. It now says what the throttle bounds (the sustained rate, best effort) and what it doesn't (a simultaneous warm burst, Bedrock requests, Lambda concurrency, one patient's use).
- **`ChatFunction`** gets `ReservedConcurrentExecutions: 5`, pinned by a template test. The PR's mutate table shows the pin going red for every edit we made to the value.

The agent deployed the api stack to `dev`, then deployed a fresh ephemeral env, `sched-ab273-*`, from the same commit and seeded it. On `ab273` it repeated #39's four `POST /api/session` runs. Then, before any other chat call, it sent 30 simultaneous signed-in `POST /api/chat` calls with body `{}`, which the handler rejects with 400 before any Bedrock call.

## Why we chose what we chose

The spec left these to us:
- **"Per method", not "one bucket".** Before rewriting the comment we checked API Gateway's throttling docs: stage-level limits "are applied at the API method level for a stage", and `/*` `*` configures "the same settings for all methods". So the comment says each method has its own bucket, shared by every client, rather than calling it one stage-wide bucket.
- **The reservation's evidence on `dev`.** The issue names `aws lambda get-function-concurrency`, and `SchedDeployer` is denied it. `aws lambda get-function` is allowed, and its `Concurrency` field read `ReservedConcurrentExecutions: 5`. We didn't look for another way past the denial.
- **The minimum Lambda keeps unreserved.** `SchedDeployer` can't call `lambda:GetAccountSettings`, so Nick corrected r1/A-5 to use Service Quotas and the docs. `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384` read 1000.0, and the Lambda docs ("Configuring reserved concurrency") say "You can reserve up to the Unreserved account concurrency value minus 100". So the standing envs' 3 × 5, plus 5 for each ephemeral env, fit easily in 900.
- **How the bursts ran.** A throwaway script outside the repo (no burst script is committed, per the readiness notes) signed in as one seeded patient with SRP and held the ID token in memory. It sent each run through the env's CloudFront domain, as the SPA does, with 3 s between runs. It printed only status codes and response bodies.
- **What we didn't run.** The runbook's smoke check ends with one signed-in turn, which calls Bedrock. We skipped it, because the chat burst had to be the env's first chat call and this issue approves no Bedrock calls. Every other smoke check passed. CloudWatch's `GetMetricStatistics` is denied to `SchedDeployer`, so the invocation counts below come from the function log groups' `platform.start` and `platform.initStart` lines, as #39's did.

## What surprised us

- **The reservation is what produced the 500s.** Of 30 simultaneous chat calls, exactly 5 reached the function and got the handler's 400. The other 25 got API Gateway's 500 with the body `{"message": "Internal server error"}` and no event. The chat log group shows 5 invocations and 5 cold starts, so Lambda refused the rest at the reservation. That answers AC3 for chat: a throttled response-streaming invocation is a plain 500, and the SPA already offers Retry for any 5xx without an event (`apps/web/src/chat/useChat.ts:114-118`). It also means each env now serves at most 5 turns at once, and the sixth patient sees "try again" (PR Verification; `ab273` deployed from `7edb209`).
- **The cold burst no longer fails.** With the quota at 1000, all 30 cold session calls got 200, against #39's 10 × 200 and 20 × 500 at a quota of 10. The session log group shows 30 cold starts (PR Verification).
- **The paced runs throttled far more than #39's.** One call every 80 ms got 8 × 200 and 32 × 429, where #39 got 1 × 429 of 40. One every 40 ms got 29 × 200 and 31 × 429, against 14 of 60 (PR Verification). We don't know why. API Gateway calls its limits targets "applied on a best-effort basis", and we don't know what gaps #39 left between runs. Either way, the throttle still answers sustained load and still lets a simultaneous burst of 30 through.
- **Lambda keeps 100 unreserved, not 10.** #39's entry said a reservation was impossible "because Lambda keeps 10 unreserved". The conclusion held at a quota of 10, but the figure was wrong.

## Evidence

- `ab273`, deployed with `scripts/deploy.sh all ab273` from `7edb209`, seeded per `docs/runbooks/deploy-env.md`. Each run's status counts are in the PR's Verification section. In summary: no 429 in either simultaneous session burst, 429s only for paced load, and 400 or 500 for every chat call, none of them 429.
- `dev`: `scripts/deploy.sh api dev` completed (`UPDATE_COMPLETE`, stack tag `git-commit` `7edb209`). `aws lambda get-function --function-name sched-dev-api-chat --query Concurrency` returned `{"ReservedConcurrentExecutions": 5}`.
- `git grep -n "10 req/min" -- infra` prints nothing.
- The security review's status rows for F-11, F-12 and F-14 to F-17, and its §1 and §2 rows that cited #273, now carry these outcomes ([`docs/research/security-review.md`](../research/security-review.md)).

## What's next

- #272 holds the rest of F-15 (the account quota) and F-18.
- Nick approves the teardown of `sched-ab273-*`, which stays up until then.
