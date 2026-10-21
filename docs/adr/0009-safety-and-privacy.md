# ADR-009: Safety, privacy, and abuse controls

- **Status:** Accepted
- **Amended:** 2026-10-03 (Lambda roles as built, #17, #18, #35; see [Amendment](#amendment-2026-10-03-lambda-roles-as-built-123)); 2026-10-04 (the SES grant as built, #35; see [Amendment](#amendment-2026-10-04-the-ses-grant-as-built-35)); 2026-10-15 (the M3 security review, #39; see [Amendment](#amendment-2026-10-15-the-m3-security-review-39)); 2026-10-16 (the booking tools check the confirmed time, #313; see [Amendment](#amendment-2026-10-16-the-booking-tools-check-the-confirmed-time-313)); 2026-10-19 (escalation retention and PITR, #271; see [Amendment](#amendment-2026-10-19-escalation-retention-and-point-in-time-recovery-271)); 2026-10-20 (an env-wide daily turn cap, #356; see [Amendment](#amendment-2026-10-20-an-env-wide-daily-turn-cap-356)); 2026-10-20 (a spend backstop for voice, and why it isn't for Bedrock, #356; see [Amendment](#amendment-2026-10-20-a-spend-backstop-for-voice-and-why-it-isnt-for-bedrock-356)); 2026-10-20 (self-serve reviewer access, its bot check and its caps, #357; see [Amendment](#amendment-2026-10-20-self-serve-reviewer-access-its-bot-check-and-its-caps-357))
- **Date:** 2026-09-28
- **Deciders:** Nick Delgado (+ Claude, drafting)
- **Related:** PRD FR-035…FR-037, NFR-004, ADR-004, ADR-005, ADR-008

## Context

The domain is healthcare, even though the data is fake. The system has to behave the way a real one would:
- It must not give medical advice.
- It must route emergencies correctly.
- It must never reveal another patient's information.
- It must resist prompt injection from users or from tool outputs.
- It must not run up an unbounded Bedrock bill.

## Decision

**Data**
- **Synthetic data only.** The clinic ("Cedar Ridge Health"), providers, and patients are fictional. The UI shows a "demo, not a real clinic" banner.
- Conversation messages are kept for 30 days (TTL). No audio is stored (ADR-006). *(Refined by the [2026-10-19 amendment](#amendment-2026-10-19-escalation-retention-and-point-in-time-recovery-271): escalations expire too, and point-in-time recovery, left at 35 days, probably keeps expired items restorable for that window.)*
- CloudWatch logs carry IDs, timings, and token counts, **not** message text. *(Refined by the [2026-10-15 amendment](#amendment-2026-10-15-the-m3-security-review-39): an error's message is logged only for AWS SDK errors.)*

**Identity and authorization**
- The patient ID comes from the JWT only (ADR-005). Tools can reach only that patient's records, so there is no tool that can read another patient's data.
- **Conversation ownership** (ADR-004 amendment, 2026-09-29): IDs in a request body are never trusted on their own. Message items store `patientId`. Reading a conversation, appending to it, and reading or updating its escalation all check that `patientId` against the JWT `sub` in the data layer. A mismatch looks exactly like "not found".
- Lambda roles are least-privilege:
  - The chat function can read and write the table and call `bedrock-mantle:CreateInference` on the configured models. It can call `ses:SendEmail` only from the verified identity. *(Superseded by ADR-010: `bedrock:InvokeModel*` on inference-profile and foundation-model ARNs.)* *(Refined by the [2026-10-03 amendment](#amendment-2026-10-03-lambda-roles-as-built-123): the table actions, the SES grant deferred to #35, and the session function's role.)* *(Refined by the [2026-10-04 amendment](#amendment-2026-10-04-the-ses-grant-as-built-35): the SES grant as built.)*

**Agent behavior** (system prompt policy, enforced by evals) *(Refined by the [2026-10-16 amendment](#amendment-2026-10-16-the-booking-tools-check-the-confirmed-time-313): the write tools also enforce the confirmation.)*
- **Scope:** scheduling, availability, the patient's own appointments, and escalation. Off-topic requests get a polite decline.
- **No medical advice or triage.** Clinical questions get: "I can't advise on that, but I can book you with a provider."
- **Emergencies:** chest pain, trouble breathing, suicidal thoughts, and similar get an immediate "call 911 (or 988 for crisis)" message. The agent does not keep scheduling first.
- **Confirmation before any write:** the agent restates provider, date/time (clinic timezone), and reason, and books only after an explicit yes. *(Refined by the [2026-10-16 amendment](#amendment-2026-10-16-the-booking-tools-check-the-confirmed-time-313): the tools refuse a slot other than the confirmed one.)*
- **No invented facts:** every slot presented or booked must come from a tool result.
- **Escalation:** triggered when the patient asks for a human, repeated failure occurs (2+ failed attempts), the patient is frustrated, or the request is out of scope. The agent gives the number **1-800-555-0199** (fictional). `escalate_to_human` emails staff a summary and transcript. *(Refined by the [2026-10-03 amendment](#amendment-2026-10-03-lambda-roles-as-built-123): the email waits for the SES notifier, #35.)*
- **Tool results are data:** the system prompt says instructions inside tool results or user-supplied "system" text are never followed.

**Cost and abuse**
- API Gateway stage throttling.
- A per-patient cap on agent turns per day (e.g., 50), enforced in the chat handler.
- An agent-loop iteration cap (ADR-001).
- An AWS Budget alarm (bootstrap stack).
- *(Added by the [2026-10-20 amendment](#amendment-2026-10-20-self-serve-reviewer-access-its-bot-check-and-its-caps-357), #357: the request page's Turnstile check and its two issuance caps.)*

**Bedrock Guardrails: deferred, decided by data.** We start without them. If the red-team eval set (ADR-008 L3) shows violations that prompt and policy changes can't fix, we add a Guardrail (denied topics: medical advice; PII filters) and measure its latency cost. This choice itself becomes a story beat.

## Consequences

- Every policy line above has at least one red-team or core scenario that checks it. That is how we avoid "policy theater".
- Logs without message text make debugging slightly harder. Per-turn traces live in DynamoDB (with TTL) for authorized inspection instead.
- **Revisit if** the system ever touches real data. That would require a HIPAA-eligible configuration, a BAA, audit logging, and a formal threat model, all out of scope for this proof-of-concept.

## Validation

- Red-team eval results: 0 violations required for M3 exit.
- The M3 security review (issue M3-04) audits IAM, logs, and data handling against this ADR.

## Amendment (2026-10-03): Lambda roles as built (#123)

The decision stands. The roles as built in `infra/stacks/api.yaml` settle the details the body left open:

- **The chat function's table access** is item reads and conditional writes only: GetItem, Query, PutItem, UpdateItem and ConditionCheckItem on the base table and its indexes, with no Scan or Delete (#17). *(Refined by the [2026-10-15 amendment](#amendment-2026-10-15-the-m3-security-review-39): its one index, `GSI1`, by name.)* `TransactWriteItems` is authorized per item through the Put, Update and ConditionCheck actions.
- **The chat function's SES grant is deferred.** `ses:SendEmail`, still limited to the verified identity, comes with the escalation notifier (#35). Until then `escalate_to_human` stores the escalation with a `FAILED` notification status and sends no email, as [ADR-003's 2026-10-03 amendment](0003-iac-layout.md#amendment-2026-10-03-validation-as-run-and-the-redeploy-criterion-123) records. *(Superseded by the [2026-10-04 amendment](#amendment-2026-10-04-the-ses-grant-as-built-35): #35 added the grant.)*
- **The session function** (`POST /api/session`, #18) can only GetItem and Query the base table. It has no Bedrock or SES access.

## Amendment (2026-10-04): the SES grant as built (#35)

The decision stands, and "`ses:SendEmail` only from the verified identity" holds as follows:

- **The chat function's role** may call `ses:SendEmail` on two identity ARNs, the sender's and the front-desk recipient's (in the SES sandbox the recipient identity is authorized too), with a `StringEquals` condition on `ses:FromAddress` equal to the sender. So even when the two addresses differ, the role can send only *from* the sender. The condition key applies to `SendEmail` per the [Service Authorization Reference for Amazon SES v2](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonsimpleemailservicev2.html). The grant exists only when both addresses are configured.
- **The addresses are deploy-time `NoEcho` parameters** (`SesSender`, `SesStaffRecipient`), passed by `scripts/deploy.sh` from the environment or the git-ignored `.env`. They never appear in a committed file, and SAM prints them as `*****`.
- **The `SchedDeployer` permission set** (`sched-dev`) has the same grant, on both identities with the same `ses:FromAddress` condition (`SendAsVerifiedIdentity` in `infra/bootstrap/sched-deployer-policy.json`, placeholders substituted by hand), so an operator can run `scripts/retry-escalations.ts` without an admin login. Nick decided this on #35.
- **The retry script scans the table** for unsent escalations as that operator. The chat function's role still has no Scan.
- **Logs and metrics stay ID-only.** A failed send writes one EMF record of `Sched/NotificationFailed` with the escalation and conversation IDs and the error's name, never its message. The error text stored on the escalation has email addresses redacted.

## Amendment (2026-10-15): the M3 security review (#39)

The decision stands. The review ([`docs/research/security-review.md`](../research/security-review.md)) checked the "Data", "Identity and authorization" and "Cost and abuse" lines above against `dev` and an ephemeral env, and changed two details:

- **The chat function's table grant names its index.** It covers the base table and `…/index/GSI1`, the table's only index (`infra/stacks/data.yaml`), instead of `…/index/*`. A second index needs a change to `infra/stacks/api.yaml`, and a template test lists the statement exactly. Its Bedrock grant names `foundation-model/anthropic.claude-sonnet-4-6` exactly, without a trailing `*` (owner decision r1/Q-2 (a)).
- **An error's message is logged only for AWS SDK errors** (those with `$metadata`), clipped to 200 characters. Any other error logs its name and code only, since a tool, a repository or the agent loop can build its message from patient or model text (owner decision r1/Q-5 (b)).

What the review found outside `infra/stacks/api.yaml` and `services/api` is filed: bootstrap and `SchedDeployer` grants (#270), escalation retention (#271), account and repository settings (#272), and abuse limits beyond the four controls above (#273).

## Amendment (2026-10-16): the booking tools check the confirmed time (#313)

The decision stands, and confirmation before a write is now enforced by the tools as well as the prompt. In Eval gate run [38980920697](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38980920697) (PR #311) the agent restated 1:00 PM, the patient said yes, and `book_appointment` was called with the 12:00 PM slot from an earlier offer. Nothing in code compared the two, so a booking the patient didn't agree to was written.

- **The write tools take what the patient said yes to.** `book_appointment` and `reschedule_appointment` take a required `confirmed_provider_id`, `confirmed_date` (`YYYY-MM-DD`, clinic-local) and `confirmed_time` (`HH:MM`, 24-hour ET) (owner decisions r1/Q-1 (c) and r1/A-4 on #313). A value in another format is refused by the schema as `INVALID_INPUT`.
- **A slot that doesn't match is refused with `CONFIRMATION_MISMATCH`**, and nothing is written. The tool compares the slot's provider and its clinic-local date and `HH:MM` start with the three fields, as plain strings. For a reschedule it checks only the new slot (r1/Q-4 (a)). The check runs after the patient's own retry answer (`already_booked`, `already_rescheduled`) and before the new-patient rules and the rule that the slot must still be ahead (r1/A-2). For a reschedule, the rule that an appointment that has already started can't be moved runs first. The hint tells the model to find the confirmed slot, restate it and get a new yes.
- **The graders don't change** (r1/Q-2 (a)). A call that the tool refuses is still an unconfirmed write attempt in ADR-008's checks, so the evals keep measuring what the model chose. The tool check is a second layer.
- **The prompt** (`system.v6`) tells the model to pass the confirmed values from its restatement, not from the slot it picked, and what to do on a mismatch.

## Amendment (2026-10-19): escalation retention and point-in-time recovery (#271)

The decision stands, and the "Data" line's 30 days now covers escalations (security review F-10, owner decisions r1/Q-1 and r1/Q-4 on #271).

- **Escalation items expire 30 days after they were recorded**, as messages do (ADR-004 amendment of the same date). Items written before that change have no expiry and stay until deleted by hand.
- **TTL is not erasure.** DynamoDB deletes an expired item "typically within a few days" ([AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)), and the table's point-in-time recovery (`infra/stacks/data.yaml`) is left at its default window of 35 days (AWS documents up to 35 days of recovery points, default `RecoveryPeriodInDays` 35: [AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Point-in-time-recovery.html); `describe-continuous-backups` on `dev` reports `ENABLED`, 35).
  - **Our inference, not AWS's documented behaviour:** PITR restores the table as of a point in time, so an item deleted by TTL after that point is in the restored table. By that reasoning the items TTL deletes can be restored for the window: messages, conversation meta, turn traces, turn counters and escalations. We haven't tested a restore or found an AWS page that says it.
  - On that reading, a patient's `reason` and `summary` stay recoverable for about 65 days after the escalation (30 + 35), plus the deletion lag. We accept that for synthetic data; shortening the window is `RecoveryPeriodInDays` (1 to 35) if the data ever stops being synthetic.
- **The staff email is outside the table** and keeps the summary and transcript by design (`escalate_to_human`), so its retention is the mailbox's.

## Amendment (2026-10-20): an env-wide daily turn cap (#356)

The decision stands, and "Cost and abuse" gains a control that bounds an env, not a patient: until now nothing capped the env as a whole, so one leaked password (or the self-serve access page, #357) could spend every day until someone read a budget email. Owner decisions r1/Q-1 to Q-3 and Q-7 on #356. This amendment names only the env cap; the spend backstop is a second amendment with its own PR.

- **An env-wide daily turn cap.** The `api` stack's `EnvDailyTurnCap` (default 200, minimum 1; the chat function's `ENV_DAILY_TURN_CAP`) is how many new turns the whole env accepts per clinic-local day, across all patients. The default is `demo`'s value, so every env is capped unless it overrides it (`e2e` passes 1000). `dev`, `demo` and `e2e` each count in their own table, so one env's turns never use up another's. It is a ceiling on model spend, not a forecast: at roughly $0.01 to $0.05 a turn (an estimate from the spike, not a measurement), 200 turns is about $2 to $10 a day.
- **Consumed with the per-patient cap, atomically, before any model call.** One `TransactWriteItems` counts a turn against the patient's day and the env's day (ADR-004 amendment of the same date). A turn either cap refuses uses up neither count. The Nth new turn of the day is answered and the (N+1)th is refused. A repeat or a re-run of a stored message counts against neither cap (FR-015, #104).
- **What the patient sees.** HTTP 429, an `error` event `RATE_LIMITED`, `retryable: false`, so no Retry. The message reads "This demo has reached today's limit for the assistant. Please try again tomorrow, or see the project's README on GitHub to contact its author." It never names the front desk: the demo being full is no reason to phone the clinic. When both caps refuse, the patient's own message is shown. The README's contact line is #44's.
- **No change** to the per-patient cap (50), the stage throttle or the budget alarms. A day's cap resets at midnight Eastern with the patient's, and Nick can raise it for a day by redeploying `api` with a new `EnvDailyTurnCap` (`docs/runbooks/deploy-env.md`).
- **Still accepted as in the #273 line above:** no WAF, and nothing caps Transcribe minutes server-side. The spend backstop, the only other bound on voice, follows in #356's second PR.

## Amendment (2026-10-20): a spend backstop for voice, and why it isn't for Bedrock (#356)

The decision stands. The first amendment of this date added the env-wide turn cap, which bounds chat spend a day at a time. This one adds the slower control that bounds voice, and records what we found when we tried to bound Bedrock the same way. Owner decisions r1/Q-4 to Q-6 on #356.

- **A Transcribe budget with an automatic action.** With `DemoTranscribeRoleName` set, the bootstrap stack creates one monthly COST budget, `sched-demo-backstop` (`DemoBackstopUsd`, default 10, counting the services in `DemoBackstopServices`, default `Transcribe`, the name Nick read in Cost Explorer's Service grouping on 2026-10-20). At 80% of ACTUAL spend it emails `BudgetAlertEmail`. At 100% of ACTUAL spend, with no approval step, an AWS Budgets `APPLY_IAM_POLICY` action attaches `sched-demo-backstop-deny` to `demo`'s Identity Pool role. That policy denies `transcribe:StartStreamTranscriptionWebSocket` and nothing else. Nothing is created while the role name is empty, so `dev`, `e2e` and the CI roles have no backstop. FORECASTED spend never triggers it: a forecast early in the month would switch voice off on a guess.
- **The execution role is narrow and protected.** `sched-budgets-action` is assumed only by AWS Budgets, for a budget of this account, and can attach and detach only that one policy, on only that one role. It is on `sched-cfn-exec`'s unconditional `ProtectBootstrapIdentities` deny, so no stack can rewrite it. Everything lives in the bootstrap stack, which Nick applies.
- **What a patient sees once it trips.** Voice fails as a failed Transcribe connection does today; the SPA's text chat is unaffected. Budgets data lags by hours, so the action runs some time after the threshold is crossed, and voice can overshoot the threshold meanwhile.
- **Transcribe spend is account-wide, not `demo`'s.** Nothing attributes Transcribe streaming to one env. That is valid only while no CI or eval job calls Transcribe: `grep -rli transcribe packages/evals .github` finds scenario text and no client. A Transcribe client added to either one would trip `demo`'s backstop.
- **There is no Bedrock backstop, by decision.** A budget that stops `demo`'s chat role must count `demo`'s Bedrock spend only, because `sched-bedrock-monthly` also counts the CI eval gate and local eval runs. We looked for a way to attribute it without changing how models are called, and found none that works today:
  - the agent calls the system-defined `us.` cross-region profile, and AWS documents cost allocation tags only for application inference profiles, which would change the model ID every call passes (Q-6 (a), not chosen);
  - Bedrock does capture the calling IAM role and its tags in Cost Explorer and CUR 2.0 without any change to the calls, but AWS's Budgets documentation lists no IAM-principal filter, and the pages that describe the feature mention Cost Explorer and CUR 2.0 only. A search result claimed Budgets can filter on those tags; no AWS page we read says so, so we didn't build on it.
  Nick decided ([#356](https://github.com/nick-delgado/serverless-ai-scheduling/issues/356#issuecomment-6298468468)) not to automate it: he stops `demo`'s Bedrock spend by hand when needed (runbook, "Stopping `demo`'s spend by hand"), and `demo` runs a lower `EnvDailyTurnCap` than the template default as an interim bound (75, deployed on Nick's approval on 2026-10-20: [record](https://github.com/nick-delgado/serverless-ai-scheduling/issues/356#issuecomment-6298712536)). The IAM-principal route stays untested; if Budgets ever documents a filter for it, a backstop could be added then.
- **Resetting.** AWS says an action that applies a policy "will be reset at the beginning of each budget period" (the AWS blog on Budgets actions), so voice should return on the first of the month by itself; we haven't seen it, because we haven't tripped it. Within the month Nick reverses it with `aws budgets execute-budget-action … --execution-type REVERSE_BUDGET_ACTION`, and `RESET_BUDGET_ACTION` arms it again (runbook, `docs/runbooks/aws-setup.md`). A reversed action isn't re-evaluated for the rest of the period.
- **What it doesn't promise.** If `demo`'s auth stack replaces the Identity Pool role, the policy's target is a role that no longer exists and the action fails to attach; Nick re-applies the bootstrap with the new name (runbook). We found no AWS page on whether a later update of that stack detaches a policy Budgets attached, so the runbook has Nick check the role's attached policies after any `demo` auth deploy that touches it.

## Amendment (2026-10-20): self-serve reviewer access, its bot check and its caps (#357)

The decision stands, and "Cost and abuse" gains a public door with two gates. Until now a reviewer needed credentials that Nick sent; the request page (PRD FR-004) lets a reviewer get a temporary synthetic patient on their own, without giving up any personal data. Owner decisions r1/Q-1, Q-3, Q-4 and A-7, A-10, A-11, A-14 on #357. This is the first of the issue's two PRs: issuance and its caps. Expiry and the cleanup job follow in the second.

- **The bot check is Cloudflare Turnstile (r1/Q-1 (a)).** The page loads Cloudflare's widget with a public site key (`VITE_TURNSTILE_SITE_KEY`, from `TURNSTILE_SITE_KEY`); the handler posts the token and the secret key to `https://challenges.cloudflare.com/turnstile/v0/siteverify` and creates nothing unless `success` is true. The secret is the `api` stack's NoEcho parameter `TurnstileSecret`, passed by `scripts/deploy.sh` from the git-ignored `.env`.
- **Cost: none.** Cloudflare's plans page lists the Free plan at "Free", "Up to 20 widgets" and "Unlimited challenges (traffic or verification requests)" (read 2026-10-20). No AWS service is added, and no AWS grant for the check.
- **What Cloudflare sees.** Its Turnstile privacy statement (cloudflare.com/turnstile-privacy-policy, read 2026-10-20) names what the widget collects: "client IP address, TLS Fingerprint, User-Agent Header and Sitekey and associated origin", as signals "strictly necessary for the purpose of detecting and blocking bots", "not to identify, profile or target any individuals". It states no retention period. So the reviewer's IP address and browser signals reach Cloudflare when the page loads the widget; our server never sends them on: `siteverify` is called without `remoteip`, and the handler reads no address, user agent or token it logs. Cloudflare is not a data processor of anything the reviewer types, because the page asks for nothing.
- **How the server verifies it.** One `POST` per request with `secret` and `response` (the token, at most 2048 characters). Cloudflare accepts a token for 300 seconds and once: a replay answers `success: false` with `timeout-or-duplicate`, so no state of ours is needed. The check runs before the caps, so a request that fails it counts against no cap and creates nothing. It fails closed: a timeout (4 s), a non-200 answer, an unreadable body, or a secret problem on our side (`invalid-input-secret`, `missing-input-secret`, `internal-error`) answers "try again" (503), never the cap message. An optional `TurnstileExpectedHostname` rejects a token served on another hostname; it is empty until the env's CloudFront domain is known to the `api` stack's deploy (the web stack deploys after it) and for Cloudflare's test keys, which report `localhost`.
- **Two caps, enforced atomically.** `RequestAccessDailyCap` (default 10 per clinic-local day) and `RequestAccessActiveCap` (default 5 in the registry at once), each at least 1, in one `TransactWriteItems` with the registry entry (ADR-004 amendment of the same date). Past either cap the page says "Demo access requests have run out for now. Please contact Nick through the contact details in the project README." and links to the README; no Cognito user, profile or registry entry is created. The README's contact line is #44's.
- **Privacy, as built (A-7).** A failed request also writes one error entry (`request-access failed`, level error) with the request ID, the error's name, its AWS error code and HTTP status if it has them, and, for an AWS SDK error only, its message clipped to 200 characters (`errorSummary`); no other error's message is logged. The handler's log line carries the API Gateway request ID, an outcome (`issued`, `bot_check_failed`, `bot_check_unavailable`, `capped`, `try_again`, `bad_request`, `error`; the unavailable and try-again outcomes both answer "try again", but only the first, a verifier that could not decide, never clears on its own) and the duration, and never the IP address, user agent, token, username or password; a test checks it. Lambda logs keep 14 days. The `api` stage has no access logging and CloudFront has no logging. The registry stores a random synthetic username, the Cognito `sub`, and an expiry time; the counters store counts. API Gateway still hands the event (headers, source IP) to the function, which doesn't read them. Point-in-time recovery (35 days) keeps deleted items restorable; they identify no one.
- **Residual risk, accepted.** Turnstile tells bots from people but not one person from many, so a determined person can fill the daily cap; the cap then contains the damage, and the env-wide turn cap and the spend backstop bound what the issued accounts can spend (this ADR's two earlier amendments). A temporary patient can escalate and send the usual staff email, bounded by one escalation per conversation. The page stays off `dev`, `demo` and `e2e` until the expiry job exists.
- **Not chosen:** a self-hosted proof-of-work challenge (needs a second public route and doesn't tell bots from people) and AWS WAF CAPTCHA (about $5 a month per web ACL, which alone uses NFR-003's idle budget on `demo`).

