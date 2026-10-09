# 2026-10-08 — Three CI roles that each trust one workflow file, and a probe that checked their subjects first

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #41, PR #224, ADR-003 ([2026-10-08 amendment](../adr/0003-iac-layout.md#amendment-2026-10-08-ci-roles-through-github-oidc-41)), #34, #40, #157

## What happened

#41 gives GitHub Actions AWS credentials without stored keys. The agent added GitHub's IAM OIDC provider and three roles to the bootstrap stack: `sched-github-deploy` for a new `.github/workflows/deploy.yml`, `sched-github-evals` for #34's eval gate, and `sched-github-e2e` for #40's E2E workflow. Nick settled the shape on the issue's readiness review: one role per workflow, a deploy that runs only when he starts it from `main`, the E2E role trusting a GitHub Environment, role ARNs in secrets with the account ID masked, and a test that pins the trust.

Each trust condition names the repository by GitHub's immutable form (owner and repository IDs), the workflow file (`job_workflow_ref`) and its context, a `dev` or `e2e` Environment or a pull request. The deploy workflow runs `scripts/deploy.sh all dev` and then `scripts/deploy-web.sh dev` unchanged. A config-only AWS profile in the runner's temp directory satisfies the scripts' `AWS_PROFILE` default, and the AWS CLI and SAM CLI take the role's credentials from the environment. The workflow also pins every action, its own and `ci.yml`'s and `pr-evidence.yml`'s, to a full commit SHA.

`scripts/bootstrap-template.test.ts` reads the template as text. For each role it checks that the trust has one statement, the audience, the exact subject and its operator, the federated principal and action, the one-hour session limit, and the role's place on `sched-cfn-exec`'s deny list, which it checks is unconditional and inside that role. It also checks the provider's URL, audience and deny entry, and, since the review round, the deploy workflow's trigger, branch guard, environment, token permission, account-ID masking and the two script calls. The agent broke each of those with `npm run mutate`: the first round's 20 edits and the review round's 24 each turned the expected test red.

## Why we chose what we chose

These are the decisions the spec left open; the agent made them and the PR lists them for Nick:

- **The E2E subject wildcards the branch** (`e2e.yml@refs/heads/*`, `StringLike`). r1/Q-2 (b) lets the `e2e` Environment's deployment-branch rule decide which branches may run E2E. With `job_workflow_ref` in the subject, an exact `StringEquals` would pin one branch and override that rule. We rejected a wildcard on the whole `job_workflow_ref`, which would let any workflow file in the environment assume the role.
- **The OIDC provider is on the deny list too.** `sched-cfn-exec` has no grant on it today, so the entry only guards against a later grant. The tests cover it.
- **The Bedrock budget's service filter is a parameter** (`BedrockBudgetServices`, default `Amazon Bedrock`). Claude charges on Bedrock may show up under per-model service names, and we couldn't check that without Cost Explorer access. With a parameter, Nick can set the filter on the apply, with no PR. We rejected guessing the per-model names in the template. On the review, Nick chose to read the names from past Claude spend in Cost Explorer before the first apply, rather than after the eval gate's first runs (runbook, setup step 1).
- **The deploy workflow prints the token's `sub` claim, and nothing else.** A refused assume role doesn't say which subject GitHub sent, so without that line a wrong string would be guesswork. The step is `continue-on-error`, so it can never block a deploy. Printing the whole token was never an option.
- **The first step checks all three secrets** (the role ARN and both SES values), not only the role ARN, because `deploy.sh` refuses the `api` stack on `dev` without the SES values, and it's better to learn that before a 20-minute build.
- **The roles get only what the scripts use.** The deploy and E2E roles drop the debugging, drift and `cloudfront:ListDistributions`/`GetDistribution` actions that `SchedDeployer` has. CloudFront invalidation is on `distribution/*`, because distribution IDs are random and we didn't verify a tag condition for it. That, and the unscoped CloudFormation reads, let the E2E role reach `dev`, which the readiness review's "the role grants nothing on `dev`" didn't allow. On PR #224's review Nick read that edge as "nothing that writes to or deploys `dev`" and kept the grants; the runbook and the template now say which grants are account-wide.
- **Exact release tags for the SHAs** (`v7.0.1`, `v7.1.0`, `v7.0.0`, `v6.3.0`; `setup-sam` has only `v3`). Each resolves to the same commit as its major tag today, so the trailing comment names the precise version.

## What surprised us

- **The deploy role's exact subject can't be seen before merge, but its format can.** GitHub only offers `workflow_dispatch` for a workflow that's on the default branch, and the deploy role trusts `deploy.yml` at `refs/heads/main` only, so the first run that can show that exact string is the first run after merge. The PR first left all three strings to their first runs. The review pointed out that the part most likely to be wrong, how the immutable prefix and `job_workflow_ref` are written under the customization, is the same in any workflow's token, and Nick chose to check it before the apply. With the customization set, the agent pushed a scratch branch, `scratch/oidc-sub-probe`, whose only workflow printed its tokens' `sub`, `job_workflow_ref` and `environment` claims (never the token), from a plain job and from a job in a scratch `oidc-probe` Environment, on push and on a draft PR (#226). The four subjects matched the template's format exactly, so no string changed. The agent then closed #226 and deleted the branch and the `oidc-probe` Environment.
- **A job that names an Environment creates it.** The probe's `environment: oidc-probe` job created that Environment, with no protection rules, on its first run. The same would happen to `dev` if the deploy workflow ran before setup step 3; its first step stops on the missing secret, before any credentials.
- **The trust test missed the likeliest widening.** The review found that a second trust statement whose list item starts with `- Sid:`, as every other statement in the template does, left every test green: the statement count looked only for `- Effect:` items, and each lookup read only the first statement. The test now counts the items under `Statement:`, and appending a second statement in either form turns it red for each role. Writing the workflow checks turned up a smaller one of the same kind: a `- run:` step that calls a script slipped past the first version of the script check.
- **`sam validate --lint` already fails on `main`'s bootstrap template.** SAM CLI 1.166.2's bundled cfn-lint flags `bedrock-mantle:CountTokens` in the permissions boundary as an unknown action (W3037). The pinned `cfn-lint` 1.57.0 that CI runs passes the template, before this change and after it. The line predates #41, so we left it alone.

## Evidence

- `cfn-lint --regions us-east-1 --template infra/bootstrap/bootstrap.yaml` (1.57.0): no findings. `sam validate --lint` (SAM CLI 1.166.2): the same W3037 on `main`'s template and on this branch's, and nothing else.
- With fake credentials in the environment and `AWS_PROFILE` set to a config-only profile, `aws sts get-caller-identity` and `sam list stack-outputs` both failed with `InvalidClientTokenId`, which means they sent the environment's credentials. Without the credentials, both failed with "Unable to locate credentials".
- `npm run mutate` on `scripts/bootstrap-template.test.ts`: 20 edits, 20 killed in the first round; 44 edits (the 20 again and 24 new), 44 killed after the review; 47 edits, 47 killed after the re-check, whose three new edits write a step in the forms the first tests missed (a `- name:`-first credentials step, a script inside a `run: |` block, a second job). The table is in the PR.
- The probe's subjects (push run [37866160868](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/37866160868), pull-request run [37866168240](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/37866168240)):
  - push, no environment: `repo:nick-delgado@25354284/serverless-ai-scheduling@1391507382:ref:refs/heads/scratch/oidc-sub-probe:job_workflow_ref:nick-delgado/serverless-ai-scheduling/.github/workflows/oidc-sub-probe.yml@refs/heads/scratch/oidc-sub-probe`
  - push, `oidc-probe` environment: `repo:nick-delgado@25354284/serverless-ai-scheduling@1391507382:environment:oidc-probe:job_workflow_ref:nick-delgado/serverless-ai-scheduling/.github/workflows/oidc-sub-probe.yml@refs/heads/scratch/oidc-sub-probe`
  - pull request, no environment: `repo:nick-delgado@25354284/serverless-ai-scheduling@1391507382:pull_request:job_workflow_ref:nick-delgado/serverless-ai-scheduling/.github/workflows/oidc-sub-probe.yml@refs/pull/226/merge`
  - pull request, `oidc-probe` environment: `repo:nick-delgado@25354284/serverless-ai-scheduling@1391507382:environment:oidc-probe:job_workflow_ref:nick-delgado/serverless-ai-scheduling/.github/workflows/oidc-sub-probe.yml@refs/pull/226/merge`

## What's next

- Nick reads the Bedrock service names, applies the bootstrap and the settings in the runbook's order, merges, runs the deploy workflow, and checks its subject line. The run link goes on #41.
- #34 and #40 copy the subject step into their workflows before their first runs. #40's first run also confirms the Cognito `env=e2e` tag condition.
- #157 absorbs this test's block slicer, which is the fourth copy.
