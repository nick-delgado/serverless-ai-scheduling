# 2026-09-29 — Least privilege meets a real deploy

**Chapter:** 3. The walking skeleton
**Milestone:** M1
**Related:** #6 (PR #52), ADR-003, runbook steps 5–6, #49, #34

## What happened

Issue #6 stood up the per-domain stacks: a DynamoDB table (data), a Cognito user pool (auth), Lambda defaults (api), and a placeholder (web). They deploy through the access model designed in Phase 0:
- agents sign in as `SchedDeployer`, which can only drive CloudFormation and pass one role;
- CloudFormation acts as `sched-cfn-exec`, which can only create IAM roles that carry a permissions boundary.

On paper this was tidy. The first deploy failed in about ten seconds:

> `sched-cfn-exec … is not authorized to perform: cloudformation:CreateChangeSet on resource: …transform/Serverless-2016-10-31`

## Why we chose what we chose

- **The fix goes in the bootstrap, and SAM stays only where it earns its place.** When you deploy with `--role-arn`, CloudFormation expands the SAM transform *as the execution role*, not as the caller. We had granted the transform to the caller only. The bootstrap now grants it to the execution role. We also noticed that three of the four templates (data, auth, web) used no SAM resource types at all, so they became plain CloudFormation. That's simpler, and closer to Nick's "CloudFormation wherever possible" goal.
- **A canary proves the boundary before anything depends on it.** The api stack carries a throwaway inline Lambda whose only job is to make CloudFormation create a Lambda role. The execution role can create roles *only* if they carry the boundary, so a successful deploy is itself the proof. It deployed on the second try, after Nick re-applied the bootstrap.

## What surprised us

- **The account's Bedrock quotas are about 1,000× below AWS defaults.** Once the deployer could read Service Quotas, it showed:
  - Sonnet 4.6 and Haiku 4.5 at **10 requests/min**, against a default of **10,000**;
  - Opus 5, Sonnet 5, and Opus 5.5 at **0 tokens/min**.

  The first explains yesterday's throttling. The second is AWS's own fingerprint for the entitlement restriction in #49. Nick requested increases, and the evidence went into the Support case.
- **Least privilege keeps paying for itself in diagnostics.** Each denied call named the exact action and principal. That turned "it doesn't work" into a one-line policy fix three times in two days. Each fix went through a PR, so the reasoning is in version control, not lost in a console.

## Evidence

- `sched-dev-data`, `-auth`, `-api`, `-web`: all `CREATE_COMPLETE`. 7 SSM parameters under `/sched/dev/`.
- Canary `sched-dev-api-canary`: `nodejs24.x`/arm64, JSON logs, 14-day log retention, role `sched-dev-api-CanaryFunctionRole-…` created under the boundary.
- Table: TTL `expiresAt` ENABLED, PITR ENABLED, GSI1, deletion protection on. User pool: Lite tier, admin-only create, deletion protection ACTIVE.
- Quota codes and values: see #49. Increase requests: Sonnet 4.6 PENDING, Haiku 4.5 CASE_OPENED (desired 10,500 RPM).

## What's next

- M1-05 (#7) replaces the canary with the streaming chat endpoint and builds the CloudFront/S3 web stack.
- The eval runner (#34) gets a global rate limiter regardless of how the quota request goes.
