# 2026-10-04 — The staff email's address stays out of the repo, the logs and its own error messages

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #35, PR #68 (decisions SPEC-3 (c), SPEC-5 (c), SMELL-3 (b)), ADR-009, PRD FR-034 and §5, #36, #38

## What happened

#35 built the SES side of escalation. `escalate_to_human` already recorded a handoff and called an injected `Notifier`. Now there's a real one. `SesNotifier` (`@sched/tools/ses`) renders a plain-text and an HTML email, sends it with SES v2 `SendEmail`, returns the `MessageId`, and throws on any failure, so the tool records `FAILED` and the patient still gets the phone number. The tool never re-sends. Nick's decision on the drift audit (option (b)) made re-sending an operator's job instead. `scripts/retry-escalations.ts <env>` finds `FAILED` and stale `PENDING` escalations, rebuilds each email from the stored records, re-sends it and records the result. A CloudWatch alarm on `Sched/NotificationFailed` says when to run it.

The repo is public, and the only real-world value in this feature is the verified SES address. So most of the work was about where that address may and may not appear.

## Why we chose what we chose

- **The address is deploy-time configuration only.** `scripts/deploy.sh` reads `SES_SENDER` and `SES_STAFF_RECIPIENT` from the environment or the git-ignored `.env`, and passes them to the api stack as `NoEcho` parameters. SAM CLI prints those as `*****` in its deploy summary (`hide_noecho_parameter_overrides` in SAM CLI 1.166). Deploying `api` to `dev` or `demo` without them fails, so a deploy from a checkout without `.env` can't quietly strip the chat function's email. An ephemeral env without them deploys with no SES grant and no notifier, and its escalations record `FAILED`.
- **The grant is the identity, not `*`.** The chat role may `ses:SendEmail` only on the sender's and recipient's identity ARNs. Both are listed because in the SES sandbox the recipient identity is authorized as well.
- **The subject carries no notice text.** Only our reason label and the escalation id, so nothing a patient or the model wrote can reach a mail header. Every value in the HTML body is escaped. That includes the ones we trust today, like the ids and the clinic-time string, because the next change might not.
- **One notice builder.** The retry script has to send what the tool would have sent. So the tool's transcript filter and notice assembly moved into `notify/notice.ts` (`buildEscalationNotice`), and the tool and the script both call it. The tool's 15 existing tests pass unchanged.
- **`PENDING` waits 10 minutes before a re-send (the spec left this open).** An escalation is `PENDING` from the moment it's recorded until the tool writes the send result, a few seconds later. A retry run in that window would email staff twice. `FAILED` is final, so it's always retried. `--min-pending-age` overrides the wait.

## What surprised us

- **SES's own error text can name the address.** A sandbox rejection reads like "Email address is not verified. The following identities failed the check…" followed by the address. The tool stores `error.name: error.message` on the escalation, and the retry script prints it. So the notifier throws a `NotificationSendError` whose message has every email address replaced by `<address>`, and keeps the SES error as `cause`. The metric record carries the error *name* only. We know this message shape from SES's documentation, not from a live rejection yet.
- **Lambda's JSON log format would have hidden the metric.** The api stack logs in JSON, and Lambda wraps `console.log` output in its own record, so CloudWatch wouldn't read an embedded-metric line written that way. The notifier writes its EMF line straight to `process.stdout`, which Lambda passes through as it is. This is the documented behaviour, but no failed send has run in `dev` yet. It needs #36's wiring first.
- **The operator can't send.** The `SchedDeployer` permission set (`sched-dev`) can scan the table but has no `ses:SendEmail`, so the retry script's dry run works as `sched-dev` but the send needs `sched-admin`. Granting `sched-dev` `ses:SendEmail` is a permission-set change, so it's Nick's decision. The runbook says to use `sched-admin` until then.

## Evidence

- Unit tests: `packages/tools/test/notify/render.test.ts` and `ses.test.ts` use a mocked SES client. `scripts/retry-escalations.test.ts` runs on DynamoDB Local with a recording notifier, covering finding, rebuilding, a successful re-send and a failed one.
- Each condition, value passed on and branch of the new code was broken on its own (a scripted list of 84 single mutations), and a test went red for each. The PR lists them.
- `sam validate --lint` passes for `infra/stacks/api.yaml`. The dev deploy and the manual send are recorded in the PR.

## What's next

- #36 wires `sesNotifierFromEnv(process.env)` into the chat handler. Until then `dev` escalations still record `FAILED` with "No notifier configured", and no metric fires for them.
- #38 puts `Sched/NotificationFailed` (dimension `Env`) on its dashboard.
- Nick decides whether `sched-dev` gets `ses:SendEmail` for the retry script.
