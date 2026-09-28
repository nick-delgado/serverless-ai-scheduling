# ADR-003: Infrastructure as code — SAM, one template per stack

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Nick Delgado (+ Claude, drafting)
- **Related:** ADR-005, ADR-007, runbook `docs/runbooks/aws-setup.md`

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

**AWS SAM, split into independent stacks**, deployed in this order:

| Stack | Template | Contents | Owner stream |
|---|---|---|---|
| `sched-bootstrap` (once, admin) | `infra/bootstrap/bootstrap.yaml` | CloudFormation execution role + permissions boundary, SAM artifact bucket, AWS Budget alarm, (later) GitHub OIDC deploy role | Nick (reviewed) |
| `sched-<env>-data` | `infra/stacks/data.yaml` | DynamoDB table + GSI, TTL | S2 |
| `sched-<env>-auth` | `infra/stacks/auth.yaml` | Cognito User Pool + app client, Identity Pool + Transcribe role | S1 |
| `sched-<env>-api` | `infra/stacks/api.yaml` | REST API (Cognito authorizer, streaming integration), Lambdas, SES identity/config | S3, S8 |
| `sched-<env>-web` | `infra/stacks/web.yaml` | S3 bucket (private), CloudFront (OAC), `/api/*` behavior → REST API | S5 |

- **Cross-stack wiring:** SSM parameters under `/sched/<env>/<stack>/<name>`, rather than `Fn::ImportValue` exports. Exports lock the producer stack, which blocks parallel iteration.
- **Environments:** `dev` for now. Templates take an `Env` parameter so an `eval` or `demo` environment is just another deploy.
- **Bundling:** `Metadata: BuildMethod: esbuild` per function; runtime `nodejs24.x`, `arm64`.
- **Least privilege:** agents deploy with the `SchedDeployer` SSO permission set, which can drive CloudFormation and `iam:PassRole` the execution role. The execution role creates resources, within a permissions boundary that every role it creates must carry.
- **Documented non-CloudFormation exceptions:**
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

`sam validate --lint` runs in CI for every template. A clean-account deploy works from the runbook alone (an M3 exit criterion).
