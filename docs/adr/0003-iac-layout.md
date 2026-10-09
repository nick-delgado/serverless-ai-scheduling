# ADR-003: Infrastructure as code — SAM, one template per stack

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Nick Delgado (+ Claude, drafting)
- **Related:** ADR-005, ADR-007, runbook `docs/runbooks/aws-setup.md`
- **Amended:** 2026-09-29 (what the first real deploys changed; see [Amendment](#amendment-2026-09-29-what-the-first-real-deploys-changed-6-7)); 2026-10-03 (validation as run, and the redeploy criterion, #123; see [Amendment](#amendment-2026-10-03-validation-as-run-and-the-redeploy-criterion-123)); 2026-10-04 (the SES grant and parameters as built, #35; see [Amendment](#amendment-2026-10-04-the-ses-grant-and-parameters-as-built-35)); 2026-10-08 (CI roles through GitHub OIDC, #41; see [Amendment](#amendment-2026-10-08-ci-roles-through-github-oidc-41))

## Context

Nick wants CloudFormation "wherever possible". Several agents will work on infrastructure in parallel, so a single monolithic template would be a merge-conflict magnet. We need:
- Lambda bundling for TypeScript.
- Local testing.
- A least-privilege deploy path for AI agents.

## Options considered

1. **Raw CloudFormation.** Maximum transparency, but verbose for Lambda/API Gateway, and there's no bundling story.
2. **AWS SAM.** SAM *is* CloudFormation (a transform), plus `sam build` with esbuild, `sam local`, and `sam validate --lint`.
3. **AWS CDK.** Excellent ergonomics; it synthesizes to CloudFormation. But the source of truth becomes TypeScript code instead of templates, which is further from "CloudFormation wherever possible".

## Decision

**AWS SAM, split into independent stacks**, deployed in this order: *(Refined by the [2026-09-29 amendment](#amendment-2026-09-29-what-the-first-real-deploys-changed-6-7): only `api` uses SAM; data, auth and web are plain CloudFormation.)*

| Stack | Template | Contents | Owner stream |
|---|---|---|---|
| `sched-bootstrap` (once, admin) | `infra/bootstrap/bootstrap.yaml` | CloudFormation execution role + permissions boundary, SAM artifact bucket, AWS Budget alarm, (later) GitHub OIDC deploy role *(Refined by the [2026-10-08 amendment](#amendment-2026-10-08-ci-roles-through-github-oidc-41): three CI roles, one per workflow, and a Bedrock budget.)* | Nick (reviewed) |
| `sched-<env>-data` | `infra/stacks/data.yaml` | DynamoDB table + GSI, TTL | S2 |
| `sched-<env>-auth` | `infra/stacks/auth.yaml` | Cognito User Pool + app client, Identity Pool + Transcribe role | S1 |
| `sched-<env>-api` | `infra/stacks/api.yaml` | REST API (Cognito authorizer, streaming integration), Lambdas, SES identity/config *(planned, #35; see the [2026-10-03 amendment](#amendment-2026-10-03-validation-as-run-and-the-redeploy-criterion-123))* *(Refined by the [2026-10-04 amendment](#amendment-2026-10-04-the-ses-grant-and-parameters-as-built-35): the SES grant and `NoEcho` address parameters, with no SES identity resource.)* | S3, S8 |
| `sched-<env>-web` | `infra/stacks/web.yaml` | S3 bucket (private), CloudFront (OAC), `/api/*` behavior → REST API | S5 |

- **Cross-stack wiring:** SSM parameters under `/sched/<env>/<stack>/<name>`, rather than `Fn::ImportValue` exports. Exports lock the producer stack, which blocks parallel iteration. *(How consumers read them is refined in the amendment below.)*
- **Environments:** `dev` for now. Templates take an `Env` parameter so an `eval` or `demo` environment is just another deploy.
- **Bundling:** `Metadata: BuildMethod: esbuild` per function; runtime `nodejs24.x`, `arm64`. *(Superseded by the 2026-09-29 amendment below: `BuildMethod: makefile`.)*
- **Least privilege:** agents deploy with the `SchedDeployer` SSO permission set, which can drive CloudFormation and `iam:PassRole` the execution role. The execution role creates resources, within a permissions boundary that every role it creates must carry. *(Refined by the [2026-10-08 amendment](#amendment-2026-10-08-ci-roles-through-github-oidc-41): GitHub Actions deploys through a second identity, an OIDC role.)*
- **Documented non-CloudFormation exceptions:** *(Refined by the [2026-10-08 amendment](#amendment-2026-10-08-ci-roles-through-github-oidc-41): the GitHub-side settings and secrets for the CI roles.)*
  - IAM Identity Center setup
  - Bedrock model access request
  - SES email-identity verification click
  - SPA asset `aws s3 sync` + CloudFront invalidation
  - Demo-user seeding: `AdminCreateUser` + seed script, because passwords shouldn't live in templates

## Consequences

- Each stream owns one template, so parallel work rarely conflicts.
- Deploy order matters (data/auth → api → web). A `scripts/deploy.sh` and the `sam-deploy` skill encode it.
- SSM lookups add a small amount of indirection. The upside: stacks can be torn down and rebuilt independently.
- **Revisit if** the stack count grows past about 8, or cross-stack wiring becomes painful. CDK would then be worth reconsidering.

## Validation

`sam validate --lint` runs in CI for every template. A clean-account deploy works from the runbook alone (an M3 exit criterion). *(Refined by the [2026-10-03 amendment](#amendment-2026-10-03-validation-as-run-and-the-redeploy-criterion-123): CI runs `cfn-lint`, and the redeploy is a new environment in a bootstrapped account.)*

## Amendment (2026-09-29): what the first real deploys changed (#6, #7)

Recorded after #6 (PR #52) and the walking skeleton #7 (PR #54). The decision above stands: SAM, one stack per domain, SSM wiring, deploys through the exec role. These three details changed, and each has a reason:

1. **SAM only where it earns its place.** data, auth, and web are **plain CloudFormation**, with no `Transform:`, because they use no `AWS::Serverless::*` resources. Only api uses SAM, for its functions and API. A side effect of the SAM transform: with `--role-arn`, CloudFormation expands it *as the execution role*, so the bootstrap grants `sched-cfn-exec` `cloudformation:CreateChangeSet` on `transform/Serverless-2016-10-31` (#6).
2. **Bundling uses `BuildMethod: makefile`, not `esbuild`.** SAM's esbuild builder runs `npm install` in an isolated copy of `CodeUri`, where npm-workspace packages that export TypeScript source (`@sched/contracts`, `@sched/agent`, …) can't resolve. Instead:
   - each function sets `Metadata: { BuildMethod: makefile, WorkingDirectory: <repo root> }`;
   - `services/api/Makefile` runs esbuild from the repo root into `$(ARTIFACTS_DIR)`, as ESM `index.mjs` targeting node24;
   - `scripts/deploy.sh` is unchanged;
   - with `nodejs*` runtimes, `sam build --cached` still reruns make on every build, so edits in `packages/*` can't ship a stale bundle (#7).
3. **Consumers read cross-stack values with dynamic references:** `{{resolve:ssm:/sched/${Env}/<stack>/<name>}}`, not `AWS::SSM::Parameter::Value<String>` parameters.
   - The problem with typed parameters: a typed parameter's default is a fixed path and can't include `Env`, so an ephemeral env (`scripts/deploy.sh all pr52`) would silently read **dev's** values, e.g. point its API at dev's user pool.
   - **Trade-off:** CloudFormation resolves the reference at deploy time only, so when a producer's value changes, the consuming stack needs a redeploy to pick it up. `scripts/deploy.sh all <env>` deploys in dependency order, which handles this.
   - **The exception:** account-wide bootstrap values that don't vary by env (`/sched/bootstrap/permissions-boundary-arn`) may stay typed parameters (#7).

The `sam-deploy` skill carries these as working rules.

## Amendment (2026-10-03): validation as run, and the redeploy criterion (#123)

The decision stands. Three details in the body no longer matched what was built or decided:

- **CI runs `cfn-lint`** (the linter behind `sam validate --lint`) on every `infra/**/*.yaml`, as the `cfn-lint` job in `.github/workflows/ci.yml` (#8). `sam validate --lint` stays the local check before a deploy.
- **The api stack has no SES resources yet.** The SES identity and the chat function's `ses:SendEmail` grant come with the escalation notifier (#35); until then escalations are stored with a `FAILED` notification status (#17). *(Superseded by the [2026-10-04 amendment](#amendment-2026-10-04-the-ses-grant-and-parameters-as-built-35): #35 added the grant and the address parameters.)*
- **The redeploy criterion is a new environment, not a new account** (decided on #123, matching PRD FR-050): a new environment in an account where the bootstrap and the runbook's one-time steps are done deploys from the runbook alone (#42). A second AWS account would add an entitlement and quota wait for little value.

## Amendment (2026-10-04): the SES grant and parameters as built (#35)

The decision stands. #35 settled the api stack's SES part:

- **No SES identity resource.** The identity is verified by hand (runbook step 7, one of the listed exceptions). The api stack takes its addresses as two `NoEcho` parameters, `SesSender` and `SesStaffRecipient`, which `scripts/deploy.sh` passes from the environment or the git-ignored `.env`. They default to empty, and an env without them gets no SES grant and no notifier. `dev` and `demo` api deploys refuse to run without them.
- **The chat function's grant** is `ses:SendEmail` on the sender's and the recipient's identity ARNs (the SES sandbox authorizes the recipient identity too), with a `StringEquals` condition on `ses:FromAddress` set to `SesSender`, so the recipient identity can't be used as a sender. ADR-009's [2026-10-04 amendment](0009-safety-and-privacy.md#amendment-2026-10-04-the-ses-grant-as-built-35) has the details.
- **A `NotificationFailedAlarm`** on `Sched/NotificationFailed` (dimension `Env`) is in the api stack, with no alarm action (#38 decides actions with its dashboard).
- **The retry script's Scan** (`scripts/retry-escalations.ts`) runs as the `sched-dev` operator, not as a stack role: the chat function's role still has no Scan.

## Amendment (2026-10-08): CI roles through GitHub OIDC (#41)

The decision stands: CloudFormation creates the resources, as `sched-cfn-exec`, and the identities that drive it can do little else. #41 adds the "(later)" GitHub role, settled on its readiness review (r1/Q-1 to Q-4, A-3 to A-5, and Nick's notes):

- **Three roles, not one.** The bootstrap stack creates GitHub's IAM OIDC provider and one role per workflow: `sched-github-deploy` (`.github/workflows/deploy.yml`), `sched-github-evals` (#34's eval gate) and `sched-github-e2e` (#40's E2E workflow). One role with three trust conditions would give every workflow the union of the three grants.
- **A second deploy identity beside `SchedDeployer`.** The deploy role has the `SchedDeployer` statements `scripts/deploy.sh` and `scripts/deploy-web.sh` use, narrowed to `dev` and without `DeleteStack`; the E2E role has the same narrowed to `e2e`, plus seeding; the eval role may only invoke the two eval models. The deploy workflow runs only when Nick starts it from `main`, so `dev` doesn't follow `main` automatically.
- **Trust pins the workflow.** Each role accepts only a token for `sts.amazonaws.com` whose subject names the repository by its immutable owner and repository IDs, the workflow file (`job_workflow_ref`) and its context (the `dev` or `e2e` GitHub Environment, or a pull request). The repository's subject customization is a GitHub setting Nick applies. A probe workflow's tokens confirmed the strings' format before the first apply, and each exact string is confirmed from its workflow's first run (runbook, "CI credentials (GitHub OIDC)").
- **No permissions boundary on these roles.** The deploy and E2E roles need `iam:PassRole` on `sched-cfn-exec`, which the boundary denies. Instead they're on `sched-cfn-exec`'s `ProtectBootstrapIdentities` deny, since its `ManageWorkloadRoles` grant covers every `role/sched-*`.
- **Role ARNs live in GitHub secrets, not SSM**, because a workflow can't read SSM before it has credentials. The GitHub-side settings are on the runbook's list of exceptions.
