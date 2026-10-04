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
| auth | `infra/stacks/auth.yaml` | Cognito User Pool + SPA client, Identity Pool + Transcribe-only browser role | `auth/user-pool-id`, `auth/user-pool-arn`, `auth/spa-client-id`, `auth/identity-pool-id` |
| api | `infra/stacks/api.yaml` | Regional REST API (OpenAPI body, Cognito authorizer, streaming Lambda integration) + handlers | `api/rest-api-id`, `api/execute-api-domain`, `api/stage-name`, `api/status` |
| web | `infra/stacks/web.yaml` | Private S3 + CloudFront (OAC); `/api/*` → REST API. The SPA files are published separately, by `scripts/deploy-web.sh` (below) | `web/bucket-name`, `web/distribution-id`, `web/domain`, `web/status` |

**Deploy order is data → auth → api → web**, because later stacks read earlier stacks' SSM parameters. `sched-bootstrap` is admin-only and deployed once by Nick. Never deploy, update, or delete it.

## Everyday commands

```bash
# needs a valid SSO session; if it's expired, ask Nick to run: aws sso login --profile sched-dev
sam validate --lint -t infra/stacks/<stack>.yaml --region us-east-1   # before every commit that touches infra
scripts/deploy.sh <stack> dev                                        # one stack
scripts/deploy.sh all dev                                            # everything, in order
scripts/deploy.sh data dev -- DeletionProtection=disabled            # overrides after -- (sent only to templates that declare them)
scripts/deploy.sh all pr52                                           # ephemeral env: sched-pr52-* (see below)
scripts/teardown.sh pr52                                             # delete an ephemeral env (refuses dev/demo)

aws cloudformation describe-stacks --stack-name sched-dev-<stack> --query 'Stacks[0].Outputs'
aws ssm get-parameters-by-path --path /sched/dev --recursive --query 'Parameters[].[Name,Value]' --output table
```

`deploy.sh` validates, builds (`.aws-sam/build-<stack>`), and deploys with:
- `--role-arn`, the CloudFormation execution role from `/sched/bootstrap/cfn-exec-role-arn`. CloudFormation acts as that role; you, as `SchedDeployer`, can only drive CloudFormation and pass that role.
- `--s3-bucket`, from `/sched/bootstrap/artifact-bucket`.
- tags `project=sched env=<env> stack=<stack> git-branch=<branch> git-commit=<sha>[-dirty]`. These are **provenance** tags: they record which branch and commit is running in an environment.

Account-specific values are resolved at runtime, so **never hard-code account IDs, ARNs, or emails in templates, samconfig, or docs.** The repo is public.

## Worktrees, the shared `dev` env, and ephemeral envs

`deploy.sh` deploys **the checkout it lives in**: `repo_root` comes from the script's own path (`${BASH_SOURCE[0]}/..`). Run from `.worktrees/<n>-<slug>/`, it uses that worktree's templates, `samconfig.toml`, and `.aws-sam/` build directory. Your branch doesn't need to be merged to deploy, and parallel worktrees don't overwrite each other's builds.

The flip side: `dev` is **shared**, and the last deploy wins. With several agents working:
- **In `dev`, deploy only the stacks your issue owns.** The script prints a note when an unmerged branch deploys to `dev`.
- **Use an ephemeral env for anything experimental or cross-stream:** `scripts/deploy.sh all <name>` creates a full, independent `sched-<name>-*` set, with its own table, user pool, and SSM parameters under `/sched/<name>/`, at about $0 idle. Names are lowercase, 2–16 characters (e.g., `pr52`, `wt15`). IAM is keyed on `sched-*`, so no permission changes are needed.
- **Ephemeral envs default to `DeletionProtection=disabled`.** When you're done, run `scripts/teardown.sh <name>`, which asks you to type the env name, or pass `--yes` in automation. Teardown empties the env's site bucket (`/sched/<name>/web/bucket-name`) before deleting the web stack, because CloudFormation can't delete a non-empty bucket. It refuses any bucket that doesn't match `sched-<name>-web-*`. Deleting the web stack takes several minutes while CloudFront disables the distribution. Ask Nick before tearing down anything you didn't create yourself in this task.
- **Check what's running:** `aws cloudformation describe-stacks --stack-name sched-dev-<stack> --query 'Stacks[0].Tags'` shows `git-branch` and `git-commit`.
- Once CI deploys from `main` (M3-06, #41), `dev` will track `main`, and branch work belongs in ephemeral envs.

**Protected envs** (`dev`, `demo`) keep deletion protection on, and `teardown.sh` refuses them. Their list is `PROTECTED_ENVS` in `deploy.sh`, `teardown.sh` and `deploy-web.sh`.

## Publishing the SPA (web)

The web stack creates an empty bucket and distribution. The SPA's files are build artifacts, not infrastructure, so they go up through the one documented CLI exception (runbook, ADR-003):

```bash
scripts/deploy-web.sh <env> --dry-run   # build and print the plan (aws s3 sync --dryrun); changes nothing
scripts/deploy-web.sh <env>             # build, sync to the site bucket, invalidate /*, wait for it
```

- **Run it after `scripts/deploy.sh` has deployed the env's auth and web stacks.** It reads everything from SSM: `auth/user-pool-id`, `auth/spa-client-id` and `auth/identity-pool-id` become `VITE_USER_POOL_ID`, `VITE_SPA_CLIENT_ID` and `VITE_IDENTITY_POOL_ID` for `npm run build -w apps/web`, and `web/bucket-name`, `web/distribution-id` and `web/domain` say where to publish. Any missing parameter stops it before the build.
- **Refusals:** a dirty working tree (untracked files included), expired credentials, a bucket that isn't `sched-<env>-web-*`, and a build without `index.html`, without files under `assets/`, or without the env's user pool ID in its bundle.
- **Caching:** `assets/*` (content-hashed by Vite) get `public, max-age=31536000, immutable`; everything else (`index.html`) gets `no-cache`. Order: new assets, then `index.html` (tagged with `git-commit` metadata), then stale files are deleted, then the invalidation, so the live `index.html` never points at a missing asset.
- **Shared `dev`:** the same rule as `deploy.sh`. It prints a note when an unmerged branch publishes to `dev` or `demo`; prefer an ephemeral env for branch work. It runs as `SchedDeployer` (S3 on `sched-*` buckets, `cloudfront:CreateInvalidation`); CloudFormation and the exec role aren't involved.
- **Check it:** `curl -sI https://<domain>/` shows `cache-control: no-cache`; an `/assets/...` file shows the one-year `max-age`. Deep links such as `/chat` on refresh return an S3 error (403) until #99.
- **Tests:** `scripts/deploy-web.test.ts` runs the script against stand-in `aws` and `npm` commands; change both together.

## Rules when editing templates

1. **Every IAM role carries the permissions boundary.** For SAM functions, `Globals.Function.PermissionsBoundary` already does this. For any explicit `AWS::IAM::Role`, set `PermissionsBoundary: !Ref PermissionsBoundaryArn`, with the parameter typed `AWS::SSM::Parameter::Value<String>` and defaulting to `/sched/bootstrap/permissions-boundary-arn`. Without it, the execution role is **denied** `iam:CreateRole`. That's by design, not a bug to work around.
2. **Role names must start with `sched-`.** SAM's generated names (`sched-<env>-<stack>-<Logical>Role-…`) already do; explicit `RoleName`s must too.
3. **The boundary is a ceiling.** It allows logs, X-Ray, CloudWatch metrics, DynamoDB item operations, Bedrock (`bedrock-mantle:CreateInference`, `bedrock:InvokeModel*`), SES send, Transcribe streaming, SSM reads, S3 get/put, Lambda invoke, and Cognito Identity credentials. It denies all IAM, Organizations, and account actions. If a function needs something outside that, stop and ask Nick. The boundary lives in the admin-only bootstrap stack.
4. **Cross-stack values go through SSM** (`/sched/<env>/<stack>/<name>`), not `Fn::ImportValue`. Exports lock the producer stack. Read another stack's env-specific value with a dynamic reference, `!Sub "{{resolve:ssm:/sched/${Env}/<stack>/<name>}}"`, not a typed `AWS::SSM::Parameter::Value<String>` parameter: a parameter's default can't include `Env`, so an ephemeral env would silently read dev's value. (Typed parameters are fine for env-independent values like the permissions boundary.)
5. **Scope function policies tightly.** Grant a table ARN from SSM, specific actions, and Bedrock only on the model or profile ARNs in use.
6. **Parameterize by `Env`.** No hard-coded `dev` anywhere.
7. **Stateful resources are protected.** The table and user pool take a `DeletionProtection` parameter, `enabled` by default.
8. Lambda defaults: `nodejs24.x`, `arm64`, JSON logs, an explicit log group with 14-day retention. Bundle TypeScript with `Metadata: { BuildMethod: makefile, WorkingDirectory: ../.. }` and a `build-<LogicalId>` target in `services/api/Makefile` (entry points in `services/api/src/handlers/`). **Not** `BuildMethod: esbuild`: it runs `npm install` in an isolated copy of `CodeUri`, which can't resolve workspace packages like `@sched/contracts` (ADR-007, #7).

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

## Teardown of a protected env (only when Nick asks)

Deleting stacks and data is destructive, so confirm with Nick first, every time.

1. Turn protection off: `scripts/deploy.sh data <env> -- DeletionProtection=disabled`, and the same for `auth`.
2. Delete in **reverse** order: web → api → auth → data:
   `aws cloudformation delete-stack --stack-name sched-<env>-<stack>` then `aws cloudformation wait stack-delete-complete --stack-name …`.
3. Leave `sched-bootstrap` alone. It's admin-only.
