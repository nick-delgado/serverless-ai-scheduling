# 2026-10-19 — The boundary keeps only what a workload role grants, and the exec-role narrowing waits for a second PR

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #270, PR #348, #39, NFR-004, ADR-003, ADR-009, ADR-010, security review F-4 to F-9, F-13, F-22 to F-24, F-3 (still open), #344

## What happened

The M3 security review (#39) could fix only `api.yaml`. Every grant it classed as avoidable in the admin-only bootstrap stack and in the `SchedDeployer` permission set went to #270, because only Nick can apply those files. The readiness review settled seven questions and ten assumptions on the issue, and Nick took every recommendation. The first of them split the work: this PR does everything except the CloudFormation execution role's service-wide actions (F-3), which come in a second PR from `main` once this one is merged, so that a deploy failure after this apply can't come from the exec role. The CI roles' narrowed grants (F-22, F-24) can still break a CI deploy, so the post-apply `deploy.yml` and `e2e.yml` runs are the check for them.

The agent (a task worker) changed:

- **The permissions boundary** (F-4, F-23): `WorkloadServices` allows 14 actions, from 31. The 15 ceiling-only ones go, with the `bedrock-mantle:*` pair. `lambda:InvokeFunction` and `s3:GetObject` appear in the stacks only in resource policies (`AWS::Lambda::Permission`, a bucket policy), which a role's boundary doesn't cap, so no deploy needs them here.
- **The three CI roles** (F-5, F-13, F-22, F-24): the evals role's `foundation-model/anthropic.claude-sonnet-4-6` loses its trailing `*`; the e2e role's seeding names `index/GSI1`; the deploy and e2e roles' artifact-bucket objects are `/sched-dev-*` and `/sched-e2e-*` (SAM uploads under the stack name, `scripts/deploy.sh --s3-prefix`); and `DescribeStacks` moves from `"*"` into each role's stack-scoped statement.
- **`SchedDeployer`** (F-6 to F-9): `SpikesAndEvals` names the six entitled profiles' ARNs (the same as `InvokeAgentModels`) with no Mantle actions; the two Transcribe streaming actions sit in their own `TranscribeStreaming` statement on `"*"`, because they take no resource; `SeedDemoUsers` drops `AdminDeleteUser` and `ListUsers`; `SeedAndEvalData` names `index/GSI1`; and drift detection gets `DetectStackResourceDrift` plus `DescribeStackDriftDetectionStatus`.
- **`scripts/bootstrap-template.test.ts`** pins each of those as an exact list, each test named for its finding, with the model ARNs derived from `MODEL_PROFILES` and the index from `createTableInput`, so a profile added without a policy change fails.

## Why we chose what we chose

- **Two PRs, not one (r1/Q-1 (b)).** One PR would stay open through every apply-and-fix round of the riskiest change, the exec role's resource narrowing, and its deploys can only be tested after an apply. Splitting leaves the exact fixes, which don't touch the exec role, to merge first.
- **Exact-list pins (r1/Q-7 (a)).** Presence and absence pins (no `index/*`, no Mantle) would pass a statement that gained some other action. An exact list fails on any added or removed entry, and each must reject the pre-change list.
- **`DescribeStacks` stays on `"*"` for `SchedDeployer` (r1/Q-3 (a)).** `docs/runbooks/deploy-env.md` lists an env's stacks with `describe-stacks` and a `--query` filter, no name. Narrowing it there would break two runbook commands. The CI roles name their stacks, so theirs is scoped.
- **The status read on `"*"` (r1/Q-5 (a)).** `DescribeStackDriftDetectionStatus` takes a detection ID, which is no ARN, so it can't be scoped to a stack. It sits in `CloudFormationReadAndValidate`. The first run after the apply confirms it.
- **The agent's own choice: A-3 waits.** The assumption that the exec role's two Bedrock reads go in this PR conflicts with the same decision's edge that this PR doesn't touch `WorkloadServiceControlPlanes`. The agent left them for the second PR, where the whole statement is rewritten. Leaving the statement alone is what makes "a deploy failure after this apply can't come from the exec role" true.

## What surprised us

- **`sam validate --lint` passes again.** SAM CLI 1.166.2's bundled linter flagged `bedrock-mantle:CountTokens` (W3037) on `main`'s template, and the earlier journal entry left it alone. With the Mantle pair out of the boundary, the same command passes. We checked both templates with the same SAM CLI.
- **Nothing needed `s3:GetObject` or `lambda:InvokeFunction` in the boundary.** The review counted them as ceiling-only, and `git grep` over `infra/stacks` found each only in a resource policy.

## What's next

- The second #270 PR: the exec role's `WorkloadServiceControlPlanes` (F-3), plus the two Bedrock reads. **Later (2026-10-19):** it did that; see [The exec role gets one statement per service](2026-10-19-the-exec-role-gets-one-statement-per-service.md).
- After Nick's apply: an ephemeral env deploy, seeding, one L1 smoke case, a `DailyTurnCap` update, teardown and the drift check, then an `Eval gate` run on a PR that touches a gated path (the evals role's ARN is checked only there), and one run each of `e2e.yml` and `deploy.yml`.
- Spike S-1's `mantle` backend stops working once the pair is gone. Spikes are throwaway, so we left it.
