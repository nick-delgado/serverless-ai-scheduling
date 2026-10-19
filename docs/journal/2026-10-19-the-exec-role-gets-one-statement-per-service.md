# 2026-10-19 — The exec role gets one statement per service

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #270, PR #353, PR #348, #39, NFR-004, ADR-003, security review F-3

## What happened

The first #270 PR (#348) left one grant alone on purpose: the CloudFormation execution role's `WorkloadServiceControlPlanes` (F-3), thirteen service-wide actions on `"*"`, plus two Bedrock reads. The reason was the order of risk. Every other change in that PR was an exact fix, and the exec role's resources can only be proven enough by a real deploy, so a wrong ARN there shows up as an AccessDenied in someone's deploy. This second PR does F-3 alone (r1/Q-1 (b)), and Nick applies it before merge.

The agent (a task worker) split the statement into one per service. Each keeps its `service:*` action, as r1/Q-2 (a) decided, and the resources changed:

- `dynamodb:*` on `table/sched-*` and `table/sched-*/index/*`; `lambda:*` on `function:sched-*`; `logs:*` on `log-group:/aws/lambda/sched-*`; `cloudwatch:*` on `alarm:sched-*` and `dashboard/sched-*`; `s3:*` on `sched-*` buckets and their objects (which covers the artifact bucket); `ssm:*` on `parameter/sched/*`.
- `cloudfront:*` (distributions and origin access controls), `apigateway:*`, `cognito-idp:*` and `cognito-identity:*` stay on `"*"`, each with its reason in a comment directly above: their resources are named by a generated ID, or the create call takes no resource.
- `events:*`, `xray:*`, `ses:*` and the two `bedrock:` reads are gone: no stack declares such a resource.

`scripts/bootstrap-template.test.ts` pins each statement's action and resources as exact lists, the order of the first ten statements, and the absence of Events, X-Ray, SES and Bedrock actions. It also reads the role's policy statements and checks that the Allow statements with a `"*"` resource (a list item, quoted with either quote mark, or with a trailing comment) are exactly the four Sids that carry a reason comment.

## Why we chose what we chose

- **Resources only, not actions (r1/Q-2 (a)).** Replacing each `service:*` with the handler actions of every `AWS::` type would be per-action research, and a missed action is a failed deploy. Naming the resources is the larger part of the narrowing for the least risk.
- **`"*"` for the generated-ID services, as Q-2 says.** The agent first wrote account- and region-scoped ARNs (`distribution/*`, `apigateway:<region>::/*`) as a narrower reading. Nick chose Q-2 as written (decision on PR #353): `"*"` with the reason above each statement, so the CloudFront function line (`function/sched-*`) went too, since `"*"` covers it.
- **No predicted `"*"` actions.** Some read and list calls take no resource (a log-group describe, an SSM parameter listing, a CloudFront list). The agent didn't add them on a guess. Q-2 has each added with its AccessDenied message once a deploy shows it, and the PR lists the ones to watch for.
- **A-3 lands here.** The two Bedrock reads go with the rest of the statement.

## What surprised us

- **A dashboard's ARN has no region** (`arn:aws:cloudwatch::<account>:dashboard/…`), unlike an alarm's. A pattern copied from the alarm line would never match.
- **The SSM pattern is `parameter/sched/*`, not `sched-*`**, because parameter names start with `/sched/`. The template parameter type `AWS::SSM::Parameter::Value<String>` reads the boundary's ARN: the `auth` and `api` stacks of the ephemeral env created without error. That doesn't tell the caller's `parameter/sched/*` read (`SchedDeployer` has one too) from the exec role's, so it isn't evidence about the exec role's `ssm` grant alone.
- **The first "only the Cognito ones keep `*`" test saw one spelling.** It matched the line `Resource: "*"` and nothing else, so a list item, single quotes or a trailing comment would have slipped past while the test name said otherwise. It now reads the role's statements, and the fix needed the reader's list branch to strip quotes itself.

## What happened after the apply

Nick applied the bootstrap stack from this branch on 2026-10-19 (`sched-bootstrap` `UPDATE_COMPLETE` at 21:30:42Z; only `CfnExecutionRole` changed; his [comment](https://github.com/nick-delgado/serverless-ai-scheduling/pull/353#issuecomment-6277839226)). The agent then ran, as `SchedDeployer`, on an ephemeral env with the narrowed role:

- `scripts/deploy.sh all <name>` created `data`, `auth`, `api` and `web`, all `CREATE_COMPLETE` (stack creation times 21:32:22Z, 21:33:02Z, 21:33:51Z and 21:34:53Z).
- `scripts/deploy.sh all <name> -- DailyTurnCap=2` took the `api` stack to `UPDATE_COMPLETE` (21:38:47Z); the other three had no changes.
- Nick approved the teardown, and the coordinator ran it: `list-stacks` showed all four stacks `DELETE_COMPLETE` (deletion times 21:40:35Z to 21:44:39Z), and `describe-stacks` found none.

No stack event in any of the four held an AccessDenied or "not authorized" reason, so none of the guessed no-resource actions (`logs:DescribeLogGroups`, `ssm:DescribeParameters`, `cloudwatch:DescribeAlarms`) was needed, and no `"*"` statement was added after the first push. That is one create, one update and one delete on a clean env; it does not cover a stack update that changes a log group, alarm or dashboard.

## What's next

- Nothing is pending on this PR beyond review. Beyond what the second PR's Q-6 (b) edge asks (deploy, update, teardown), Nick also ran `deploy.yml` on `main` after the apply: [run 39331000263](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/39331000263), job "Deploy dev", 21:53:52Z to 21:59:16Z, success. `e2e.yml` was not run: Nick decided to skip it for this PR, and the second PR's Q-6 (b) edge asks only for the deploy, update and teardown checks.
