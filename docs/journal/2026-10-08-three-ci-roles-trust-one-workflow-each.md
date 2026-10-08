# 2026-10-08 — Three CI roles that each trust one workflow file, with subjects we can only confirm after merge

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #41, ADR-003 ([2026-10-08 amendment](../adr/0003-iac-layout.md#amendment-2026-10-08-ci-roles-through-github-oidc-41)), #34, #40, #157

## What happened

#41 gives GitHub Actions AWS credentials without stored keys. The agent added GitHub's IAM OIDC provider and three roles to the bootstrap stack: `sched-github-deploy` for a new `.github/workflows/deploy.yml`, `sched-github-evals` for #34's eval gate, and `sched-github-e2e` for #40's E2E workflow. Nick settled the shape on the issue's readiness review: one role per workflow, a deploy that runs only when he starts it from `main`, the E2E role trusting a GitHub Environment, role ARNs in secrets with the account ID masked, and a test that pins the trust.

Each trust condition names the repository by GitHub's immutable form (owner and repository IDs), the workflow file (`job_workflow_ref`) and its context, a `dev` or `e2e` Environment or a pull request. The deploy workflow runs `scripts/deploy.sh all dev` and then `scripts/deploy-web.sh dev` unchanged. A config-only AWS profile in the runner's temp directory satisfies the scripts' `AWS_PROFILE` default, and the AWS CLI and SAM CLI take the role's credentials from the environment. The workflow also pins every action, its own and `ci.yml`'s and `pr-evidence.yml`'s, to a full commit SHA.

`scripts/bootstrap-template.test.ts` reads the template as text. For each role it checks the audience, the exact subject and its operator, the federated principal, the one-hour session limit, and the role's place on `sched-cfn-exec`'s deny list. It also checks the provider's URL, audience and deny entry. The agent broke each of those once with `npm run mutate`, and all 20 edits turned the expected test red.

## Why we chose what we chose

These are the decisions the spec left open; the agent made them and the PR lists them for Nick:

- **The E2E subject wildcards the branch** (`e2e.yml@refs/heads/*`, `StringLike`). r1/Q-2 (b) lets the `e2e` Environment's deployment-branch rule decide which branches may run E2E. With `job_workflow_ref` in the subject, an exact `StringEquals` would pin one branch and override that rule. We rejected a wildcard on the whole `job_workflow_ref`, which would let any workflow file in the environment assume the role.
- **The OIDC provider is on the deny list too.** `sched-cfn-exec` has no grant on it today, so the entry only guards against a later grant. The tests cover it.
- **The Bedrock budget's service filter is a parameter** (`BedrockBudgetServices`, default `Amazon Bedrock`). Claude charges on Bedrock may show up under per-model service names, and we couldn't check that without Cost Explorer access. With a parameter, Nick can fix the filter when he re-applies, with no PR. We rejected guessing the per-model names in the template.
- **The deploy workflow prints the token's `sub` claim, and nothing else.** A refused assume role doesn't say which subject GitHub sent, so without that line a wrong string would be guesswork. The step is `continue-on-error`, so it can never block a deploy. Printing the whole token was never an option.
- **The first step checks all three secrets** (the role ARN and both SES values), not only the role ARN, because `deploy.sh` refuses the `api` stack on `dev` without the SES values, and it's better to learn that before a 20-minute build.
- **The roles get only what the scripts use.** The deploy and E2E roles drop the debugging, drift and `cloudfront:ListDistributions`/`GetDistribution` actions that `SchedDeployer` has. CloudFront invalidation is on `distribution/*`, because distribution IDs are random and we didn't verify a tag condition for it.
- **Exact release tags for the SHAs** (`v7.0.1`, `v7.1.0`, `v7.0.0`, `v6.3.0`; `setup-sam` has only `v3`). Each resolves to the same commit as its major tag today, so the trailing comment names the precise version.

## What surprised us

- **The subjects can't be confirmed before merge.** The plan said Nick applies the bootstrap and the settings before merging, so that the first run proves the trust. But GitHub only offers `workflow_dispatch` for a workflow that's on the default branch, and the deploy role trusts `deploy.yml` at `refs/heads/main` only. So the first run that can show the real subject is the first run after merge. The workflow's subject line exists because of this, and the runbook says how to correct a string in a follow-up PR.
- **`sam validate --lint` already fails on `main`'s bootstrap template.** SAM CLI 1.166.2's bundled cfn-lint flags `bedrock-mantle:CountTokens` in the permissions boundary as an unknown action (W3037). The pinned `cfn-lint` 1.57.0 that CI runs passes the template, before this change and after it. The line predates #41, so we left it alone.

## Evidence

- `cfn-lint --regions us-east-1 --template infra/bootstrap/bootstrap.yaml` (1.57.0): no findings. `sam validate --lint` (SAM CLI 1.166.2): the same W3037 on `main`'s template and on this branch's, and nothing else.
- With fake credentials in the environment and `AWS_PROFILE` set to a config-only profile, `aws sts get-caller-identity` and `sam list stack-outputs` both failed with `InvalidClientTokenId`, which means they sent the environment's credentials. Without the credentials, both failed with "Unable to locate credentials".
- `npm run mutate` on `scripts/bootstrap-template.test.ts`: 20 edits, 20 killed (the table is in the PR).

## What's next

- Nick applies the bootstrap and the settings in the runbook's order, merges, runs the deploy workflow, and checks its subject line. The run link goes on #41.
- #34 and #40 copy the subject step into their workflows before their first runs. #40's first run also confirms the Cognito `env=e2e` tag condition.
- #157 absorbs this test's block slicer, which is the fourth copy.
