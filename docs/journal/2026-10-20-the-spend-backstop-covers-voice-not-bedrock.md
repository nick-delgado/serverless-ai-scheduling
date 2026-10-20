# 2026-10-20 — The spend backstop covers voice but not Bedrock, because Bedrock can't be told apart without changing the model IDs

**Chapter:** 6. What I'd do next
**Milestone:** M4
**Related:** #356 (second of two PRs), PR #TBD, PR #358, #357, #44, ADR-009, PRD NFR-004

## What happened

#356 asked for two limits: the env-wide turn cap, which shipped first (PR #358), and a slower backstop that switches `demo`'s model and voice calls off once a `demo`-only spend threshold is crossed. Nick settled the design on the issue: one monthly budget, an automatic AWS Budgets action at 100% of actual spend, an email at 80%, everything in the bootstrap stack, and, if Bedrock spend couldn't be attributed to `demo` without changing how models are called, no Bedrock backstop (r1/Q-6 (b)).

The agent researched the attribution before writing any template, and it couldn't find a route for Bedrock that fits that condition. So this PR ships the backstop for Transcribe only: bootstrap, when `DemoTranscribeRoleName` is set, creates the `sched-demo-backstop` budget on the account's Transcribe spend, a deny policy for `transcribe:StartStreamTranscriptionWebSocket`, an action that attaches it to `demo`'s Identity Pool role at 100% actual, and the execution role `sched-budgets-action`. The Bedrock half is left to Nick by hand: he decided ([#356 comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/356#issuecomment-6298468468)) there is no automated Bedrock backstop, and that `demo` gets a lower `EnvDailyTurnCap` than the template default on its next deploy as an interim bound (the value and the deploy are his; no template default changed). The runbook's "Stopping `demo`'s spend by hand" says how.

## Why we chose what we chose

The settled decisions are on #356. These are the agent's, where the issue was silent or the research changed the premise, each with the alternative it beat.

- **Transcribe only, and the deny policy has one action, not three.** The issue's acceptance criterion lists `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` and the Transcribe action. With no `demo`-only Bedrock budget, a deny on the chat role would trip on spend that isn't `demo`'s (the CI eval gate's, local runs'), which is the reason for the criterion's own warning. Q-6 (b) says no Bedrock backstop then, so the policy denies the Transcribe action and the action targets one role. The alternative, tripping `demo`'s chat role on the account's Bedrock budget, was ruled out by the issue itself.
- **One role-name parameter, not two.** With no Bedrock backstop nothing targets the chat role, so `DemoChatRoleName` (Q-5 (a)) isn't added. A Bedrock backstop would add it.
- **The service names are a parameter (`DemoBackstopServices`, default `Transcribe`).** The agent didn't make a billed Cost Explorer call to read the name; Nick read it in Cost Explorer's Service grouping on 2026-10-20 (`Transcribe`, not the `Amazon Transcribe` the agent had guessed) and the default follows. It stays a parameter so an apply can correct it, as `BedrockBudgetServices` is. The alternative, a literal, would stall the budget on a wrong name.
- **The role name has a pattern (`AllowedPattern`).** It goes into an ARN in the execution role's grant, so a value with `/` or `*` could widen what the role may touch. A test feeds the template's own pattern good and bad names.
- **The trust follows AWS's documented example** (`budgets.amazonaws.com`, `aws:SourceAccount`, `aws:SourceArn` of `budget/*`) rather than naming this one budget. We couldn't tell from the documentation whether Budgets sets the budget's or the action's ARN as the source, and a trust that doesn't match fails silently when the action runs.
- **The 80% email is on the budget; the action carries its own email subscriber.** CloudFormation's `BudgetsAction` requires one, so Nick gets a mail when the action runs.

## What surprised us

- **Bedrock can't be attributed here, and the reason is three separate gaps.** (1) The agent calls the system-defined `us.` cross-region profile, and AWS documents cost allocation tags only on application inference profiles ([AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-application-inference-profiles.html)), which would change the model ID every call passes. (2) Bedrock does record the calling IAM role and its tags with no change to the calls, but those reach Cost Explorer and CUR 2.0 ([AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html)); AWS's list of Budgets filters has no IAM-principal one ([AWS](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create-filters.html)): its Tag filter takes AWS-generated and `user:` tags. One search summary said Budgets can filter on those tags, and we found no AWS page that does, so we didn't build on it. (3) A Cost Explorer query to look would cost $0.01 a call and wasn't made. The route worth testing is the second, on an ephemeral env.
- **An applied policy doesn't stay into next month, as the issue assumed (A-11 (1)).** The AWS blog says an action that applies a policy "will be reset at the beginning of each budget period". The reverse and reset calls are in the CLI (`REVERSE_BUDGET_ACTION`, `RESET_BUDGET_ACTION`), as assumed (A-11 (2)). Whether a CloudFormation update of the target role's stack detaches a policy Budgets attached (A-11 (3)) we found no AWS statement on; the runbook has Nick check the role's attached policies after a `demo` auth deploy. None of the three has been seen live.

## Evidence

- The template and its tests are in the PR; the seen-failing table, the coverage gate and the lint, typecheck and test results are in the PR description, for the commit it names.
- `cfn-lint infra/bootstrap/bootstrap.yaml` and `sam validate --lint -t infra/bootstrap/bootstrap.yaml --region us-east-1` pass on the template as committed.
- Read-only: `describe-stack-resource` on `sched-demo-auth` returns the Identity Pool role's physical name (`sched-demo-auth-TranscribeBrowserRole-<suffix>`), so the runbook's command works. `describe-budget` on `sched-bedrock-monthly` shows its Service filter lists three names, one of them a per-model name, which is why `BedrockBudgetServices` is a parameter.
- Not done, pending Nick: the bootstrap apply, and the standby check after it (`docs/runbooks/aws-setup.md`, "The demo spend backstop"). The trigger itself has not been shown.

## What's next

- Nick picks `demo`'s lower `EnvDailyTurnCap` and deploys it; the in-band way to stop spend is in the runbook.
- Nick applies the bootstrap with `DemoTranscribeRoleName`, then checks the action is on standby.
