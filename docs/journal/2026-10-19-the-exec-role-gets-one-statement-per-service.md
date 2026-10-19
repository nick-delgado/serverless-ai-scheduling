# 2026-10-19 — The exec role gets one statement per service

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #270, PR #353, PR #348, #39, NFR-004, ADR-003, security review F-3

## What happened

The first #270 PR (#348) left one grant alone on purpose: the CloudFormation execution role's `WorkloadServiceControlPlanes` (F-3), thirteen service-wide actions on `"*"`, plus two Bedrock reads. The reason was the order of risk. Every other change in that PR was an exact fix, and the exec role's resources can only be proven enough by a real deploy, so a wrong ARN there shows up as an AccessDenied in someone's deploy. This second PR does F-3 alone (r1/Q-1 (b)), and Nick applies it before merge.

The agent (a task worker) split the statement into one per service. Each keeps its `service:*` action, as r1/Q-2 (a) decided, and the resources changed:

- `dynamodb:*` on `table/sched-*` and `table/sched-*/index/*`; `lambda:*` on `function:sched-*`; `logs:*` on `log-group:/aws/lambda/sched-*`; `cloudwatch:*` on `alarm:sched-*` and `dashboard/sched-*`; `s3:*` on `sched-*` buckets and their objects (which covers the artifact bucket); `ssm:*` on `parameter/sched/*`.
- `cloudfront:*` on `distribution/*` and `origin-access-control/*` in this account, and `function/sched-*`. `apigateway:*` on `/*` in this region.
- `cognito-idp:*` and `cognito-identity:*` stay on `"*"`, each with its reason in a comment directly above.
- `events:*`, `xray:*`, `ses:*` and the two `bedrock:` reads are gone: no stack declares such a resource.

`scripts/bootstrap-template.test.ts` pins each statement's action and resources as exact lists, the order of the statements, the absence of the dropped services, and that the only `"*"` grants are the two Cognito ones, each with a comment above it.

## Why we chose what we chose

- **Resources only, not actions (r1/Q-2 (a)).** Replacing each `service:*` with the handler actions of every `AWS::` type would be per-action research, and a missed action is a failed deploy. Naming the resources is the larger part of the narrowing for the least risk.
- **Account- and region-scoped ARNs where the name is a generated ID.** Q-2 says to keep `"*"` for API Gateway, CloudFront distributions and origin access controls. The agent kept the reasons but wrote `distribution/*`, `origin-access-control/*` and the region's `apigateway:::/*` instead, because they cost nothing: every stack lives in one account and region. Putting those on `"*"` would also have made the `function/sched-*` line meaningless, since `cloudfront:*` on `"*"` covers it. This is a small deviation from Q-2's wording, called out in the PR.
- **No predicted `"*"` actions.** Some read and list calls take no resource (a log-group describe, an SSM parameter listing, a CloudFront list). The agent didn't add them on a guess. Q-2 has each added with its AccessDenied message once a deploy shows it, and the PR lists the ones to watch for.
- **A-3 lands here.** The two Bedrock reads go with the rest of the statement.

## What surprised us

- **A dashboard's ARN has no region** (`arn:aws:cloudwatch::<account>:dashboard/…`), unlike an alarm's. A pattern copied from the alarm line would never match.
- **The SSM pattern is `parameter/sched/*`, not `sched-*`.** Parameter names start with `/sched/`, and the template parameter type `AWS::SSM::Parameter::Value<String>` that reads the boundary's ARN is resolved under the same grant.

## What's next

- Nick's apply, then the deploy, update and teardown of an ephemeral env. The first deploy is the real test of these ARNs.
- Any AccessDenied it shows becomes its own `"*"` statement for that service, with a comment, in a fix commit on this branch.
