---
name: sam-deploy
description: >-
  How to change, validate, deploy, and tear down this project's AWS infrastructure. It covers the
  AWS SAM/CloudFormation stacks in infra/stacks (data, auth, api, web), scripts/deploy.sh,
  SSM-parameter wiring between stacks, the permissions-boundary rule for IAM roles, and fixing
  failed deploys. Use it whenever you edit anything under infra/, add a Lambda function or AWS
  resource, deploy to dev (or any env), read stack outputs, hit a CloudFormation error such as
  ROLLBACK_COMPLETE or AccessDenied, or when the user says "deploy", "sam", "stack", "CloudFormation",
  "provision", or "tear down", even if they don't name SAM.
---

# SAM deploy

Infrastructure is AWS SAM (CloudFormation) with **one template per stack** (ADR-003), so parallel streams rarely edit the same file. Everything goes through CloudFormation. The only manual exceptions are listed in `docs/runbooks/aws-setup.md`.

## The stacks

| Stack (`sched-<env>-…`) | Template | Owns | Publishes to SSM (`/sched/<env>/…`) |
|---|---|---|---|
| data | `infra/stacks/data.yaml` | DynamoDB `sched-<env>-main` (+ GSI1, TTL, PITR) | `data/table-name`, `data/table-arn` |
| auth | `infra/stacks/auth.yaml` | Cognito User Pool + SPA client (Identity Pool comes with S1-01) | `auth/user-pool-id`, `auth/user-pool-arn`, `auth/spa-client-id` |
| api | `infra/stacks/api.yaml` | REST API + Lambda handlers (canary until M1-05) | `api/status` (more once the API exists) |
| web | `infra/stacks/web.yaml` | S3 + CloudFront (placeholder until M1-05) | `web/status` |

**Deploy order is data → auth → api → web**, because later stacks read earlier stacks' SSM parameters. `sched-bootstrap` is admin-only and deployed once by Nick. Never deploy, update, or delete it.

## Everyday commands

```bash
# needs a valid SSO session; if it's expired, ask Nick to run: aws sso login --profile sched-dev
sam validate --lint -t infra/stacks/<stack>.yaml --region us-east-1   # before every commit that touches infra
scripts/deploy.sh <stack> dev                                        # one stack
scripts/deploy.sh all dev                                            # everything, in order
scripts/deploy.sh data dev -- DeletionProtection=disabled            # extra parameter overrides after --

aws cloudformation describe-stacks --stack-name sched-dev-<stack> --query 'Stacks[0].Outputs'
aws ssm get-parameters-by-path --path /sched/dev --recursive --query 'Parameters[].[Name,Value]' --output table
```

`deploy.sh` validates, builds (`.aws-sam/build-<stack>`), and deploys with:
- `--role-arn`, the CloudFormation execution role from `/sched/bootstrap/cfn-exec-role-arn`. CloudFormation acts as that role; you, as `SchedDeployer`, can only drive CloudFormation and pass that role.
- `--s3-bucket`, from `/sched/bootstrap/artifact-bucket`.
- tags `project=sched env=<env> stack=<stack>`.

Account-specific values are resolved at runtime, so **never hard-code account IDs, ARNs, or emails in templates, samconfig, or docs.** The repo is public.

## Rules when editing templates

1. **Every IAM role carries the permissions boundary.** For SAM functions, `Globals.Function.PermissionsBoundary` already does this. For any explicit `AWS::IAM::Role`, set `PermissionsBoundary: !Ref PermissionsBoundaryArn`, with the parameter typed `AWS::SSM::Parameter::Value<String>` and defaulting to `/sched/bootstrap/permissions-boundary-arn`. Without it, the execution role is **denied** `iam:CreateRole`. That's by design, not a bug to work around.
2. **Role names must start with `sched-`.** SAM's generated names (`sched-<env>-<stack>-<Logical>Role-…`) already do; explicit `RoleName`s must too.
3. **The boundary is a ceiling.** It allows logs, X-Ray, CloudWatch metrics, DynamoDB item operations, Bedrock (`bedrock-mantle:CreateInference`, `bedrock:InvokeModel*`), SES send, Transcribe streaming, SSM reads, S3 get/put, Lambda invoke, and Cognito Identity credentials. It denies all IAM, Organizations, and account actions. If a function needs something outside that, stop and ask Nick. The boundary lives in the admin-only bootstrap stack.
4. **Cross-stack values go through SSM** (`/sched/<env>/<stack>/<name>`), not `Fn::ImportValue`. Exports lock the producer stack.
5. **Scope function policies tightly.** Grant a table ARN from SSM, specific actions, and Bedrock only on the model or profile ARNs in use.
6. **Parameterize by `Env`.** No hard-coded `dev` anywhere.
7. **Stateful resources are protected.** The table and user pool take a `DeletionProtection` parameter, `enabled` by default.
8. Lambda defaults: `nodejs24.x`, `arm64`, JSON logs, an explicit log group with 14-day retention. Bundle TypeScript with `Metadata: { BuildMethod: esbuild }` (entry points in `services/api/src/handlers/`).

## Before opening a PR that touches infra

- [ ] `sam validate --lint` passes for every changed template. CI also runs `cfn-lint` on `infra/**/*.yaml`.
- [ ] Deployed to `dev` with `scripts/deploy.sh`, or the PR says why not.
- [ ] Any new SSM parameters and outputs are listed in the stack table above and in `docs/architecture.md`.
- [ ] No account IDs, ARNs, or emails in the diff.

## When a deploy fails

| Symptom | Likely cause | Fix |
|---|---|---|
| `AccessDenied … iam:CreateRole` | Role missing the permissions boundary, or its name isn't `sched-*` | Add the boundary (rule 1) or rename (rule 2) |
| `sched-cfn-exec … not authorized to perform: cloudformation:CreateChangeSet on … transform/Serverless-2016-10-31` | With `--role-arn`, the **execution role** expands the SAM transform; the bootstrap stack must grant it (fixed in #6) | Nick redeploys `sched-bootstrap` (runbook step 5). Templates without `AWS::Serverless::*` resources should omit `Transform:` entirely; data, auth, and web are plain CloudFormation |
| `AccessDenied` as `SchedDeployer` on a non-CloudFormation action | The deploy path needs a permission the policy lacks | Tell Nick which action; the policy is `infra/bootstrap/sched-deployer-policy.json` |
| `ROLLBACK_COMPLETE` on the first create | The initial create failed; CloudFormation won't update it | Read the events (`aws cloudformation describe-stack-events --stack-name …`), fix the cause, then **ask Nick before deleting** the failed stack and redeploying |
| `UPDATE_ROLLBACK_FAILED` | Usually a resource changed outside CloudFormation | Stop and ask. Don't force-continue. |
| `Credentials … expired` | SSO session over (8 h) | Ask Nick: `aws sso login --profile sched-dev` |
| Cognito/DynamoDB won't delete | Deletion protection is on (intended) | See teardown |

Read the failure reason first:

```bash
aws cloudformation describe-stack-events --stack-name sched-dev-<stack> \
  --query 'StackEvents[?contains(ResourceStatus, `FAILED`)].[LogicalResourceId,ResourceStatusReason]' --output table
```

## Teardown (only when Nick asks)

Deleting stacks and data is destructive, so confirm with Nick first, every time.

1. Turn protection off: `scripts/deploy.sh data <env> -- DeletionProtection=disabled`, and the same for `auth`.
2. Delete in **reverse** order: web → api → auth → data:
   `aws cloudformation delete-stack --stack-name sched-<env>-<stack>` then `aws cloudformation wait stack-delete-complete --stack-name …`.
3. Leave `sched-bootstrap` alone. It's admin-only.
