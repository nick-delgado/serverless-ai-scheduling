# Runbook: AWS account setup (one-time, human)

These steps give AI agents **scoped, short-lived** access to the AWS account and lay the foundation every stack depends on. Nick runs them once. After step 7, agents deploy everything else through CloudFormation, and so does the deploy workflow when Nick runs it ("CI credentials (GitHub OIDC)", below).

**Access model**
- People and agents use two SSO identities: an **admin** permission set used only by Nick for the bootstrap, and a **`SchedDeployer`** permission set used by agents. SchedDeployer can drive `sched-*` CloudFormation stacks and pass one role, `sched-cfn-exec`. That role creates the resources, and every workload role it creates must carry a permissions boundary.
- GitHub Actions workflows use three bootstrap roles, one per workflow, each assumable only with a short-lived GitHub OIDC token for that workflow: **`sched-github-deploy`** (the deploy workflow; it writes only to `dev`), **`sched-github-evals`** (#34's CI eval gate, Bedrock only) and **`sched-github-e2e`** (#40's E2E workflow; it writes only to the `e2e` env). They're set up in "CI credentials (GitHub OIDC)", below.
- Nobody has long-lived access keys: people and agents sign in with SSO, and workflows get one-hour credentials from OIDC. The rationale is in ADR-003 and its [2026-10-08 amendment](../adr/0003-iac-layout.md#amendment-2026-10-08-ci-roles-through-github-oidc-41).

Region: **us-east-1** throughout.

---

## 1. Install tooling (macOS)

```bash
brew install awscli aws-sam-cli
pipx install cfn-lint        # or: brew install cfn-lint
aws --version && sam --version && cfn-lint --version
```

## 2. Enable IAM Identity Center

1. AWS console → **IAM Identity Center** → **Enable**. Choose an organization instance; this creates an AWS Organization if you don't have one. Home region: `us-east-1`.
2. **Users** → create a user for yourself (e.g., `nick`) and complete the email invitation, including MFA.
3. Note the **AWS access portal URL** (e.g., `https://d-xxxxxxxxxx.awsapps.com/start`).

## 3. Create permission sets

In **IAM Identity Center → Permission sets**:

| Permission set | Policy | Session duration | Used by |
|---|---|---|---|
| `AdministratorAccess` | AWS managed `AdministratorAccess` | 1 h | Nick only: bootstrap (step 5) and break-glass |
| `SchedDeployer` | **Inline policy** from `infra/bootstrap/sched-deployer-policy.json` | 8 h | Claude Code agents (`sched-dev` profile) |

Before pasting the inline policy, substitute your account ID and the two SES identities: the sender (`<SES_IDENTITY>`, the same value as `SES_SENDER` in the git-ignored `.env`) and the front-desk recipient (`<SES_RECIPIENT>`, the same value as `SES_STAFF_RECIPIENT`; in the one-address setup of step 7 both are the same address). The grant lets agents send escalation emails and run `scripts/retry-escalations.ts`, and its `ses:FromAddress` condition allows only the sender as the From address:

```bash
ACCOUNT_ID=123456789012              # your 12-digit account ID
SES_IDENTITY=you@example.com         # the verified sender identity; never commit the real one
SES_RECIPIENT=you@example.com        # the verified recipient identity (the same address in a one-address setup)
sed -e "s/<ACCOUNT_ID>/$ACCOUNT_ID/g" -e "s/<SES_IDENTITY>/$SES_IDENTITY/g" -e "s/<SES_RECIPIENT>/$SES_RECIPIENT/g" \
  infra/bootstrap/sched-deployer-policy.json | pbcopy
```

Then go to **AWS accounts**, select the account, choose **Assign users or groups**, pick your user, and assign **both** permission sets.

> **Review the policy before applying it.** It allows:
> - driving `sched-*` CloudFormation stacks, passing only `sched-cfn-exec`, and writing to `sched-*` S3 buckets;
> - read-only debugging (logs, Lambda, DynamoDB, API Gateway, CloudWatch);
> - seeding `sched-*` tables and Cognito demo users;
> - calling Bedrock (`bedrock-mantle:CreateInference`) and Transcribe for spikes and evals.
>
> It **cannot** modify IAM directly or touch the `sched-bootstrap` stack.

## 4. Configure CLI profiles

```bash
aws configure sso --profile sched-admin      # choose AdministratorAccess, region us-east-1, output json
aws configure sso --profile sched-dev        # choose SchedDeployer,     region us-east-1, output json
aws sso login --profile sched-dev
aws sts get-caller-identity --profile sched-dev   # should show …/AWSReservedSSO_SchedDeployer_…
```

When a session expires, agents will ask you to run `aws sso login --profile sched-dev`. In Claude Code, type `! aws sso login --profile sched-dev`.

## 5. Deploy the bootstrap stack (admin, once)

```bash
aws sso login --profile sched-admin
cfn-lint infra/bootstrap/bootstrap.yaml
aws cloudformation deploy \
  --profile sched-admin --region us-east-1 \
  --stack-name sched-bootstrap \
  --template-file infra/bootstrap/bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides BudgetLimitUsd=25 BudgetAlertEmail=you@example.com
aws cloudformation describe-stacks --profile sched-admin --stack-name sched-bootstrap \
  --query 'Stacks[0].Outputs' --output table
```

This creates:
- `sched-cfn-exec` (the CloudFormation execution role);
- `sched-permissions-boundary`;
- the `sched-artifacts-<account>-us-east-1` bucket;
- the `sched-monthly` budget (alerts at 80% actual and 100% forecast);
- the `sched-bedrock-monthly` budget, Amazon Bedrock spend only (`BedrockBudgetLimitUsd`, default 10 USD; the same alerts and email);
- GitHub's IAM OIDC provider (`token.actions.githubusercontent.com`) and the three CI roles `sched-github-deploy`, `sched-github-evals` and `sched-github-e2e` (outputs `GitHubDeployRoleArn`, `GitHubEvalsRoleArn`, `GitHubE2eRoleArn`);
- SSM parameters under `/sched/bootstrap/`.

Confirm the budget alert subscription email if AWS sends one.

### Updating the bootstrap stack later

When a PR changes `infra/bootstrap/bootstrap.yaml`, re-apply it as admin. Existing parameter values (budget, email) are kept when you omit them:

```bash
aws sso login --profile sched-admin
aws cloudformation deploy --profile sched-admin --region us-east-1 \
  --stack-name sched-bootstrap --template-file infra/bootstrap/bootstrap.yaml --capabilities CAPABILITY_NAMED_IAM
```

When a PR changes `infra/bootstrap/sched-deployer-policy.json`, check the CI roles in `bootstrap.yaml` that copy its statements (each copy says so), then go to **IAM Identity Center → Permission sets → SchedDeployer → Inline policy**, paste the new version (with `<ACCOUNT_ID>`, `<SES_IDENTITY>` and `<SES_RECIPIENT>` substituted, as in step 3), and then choose **Provision** (or "Update") on the account.

### CI credentials (GitHub OIDC)

The bootstrap stack gives GitHub Actions short-lived credentials (#41): GitHub's OIDC provider and one role per workflow, each with its own grants, so no workflow gets the union of the three. A role's trust accepts a token only when its audience is `sts.amazonaws.com` and its subject (`sub`) names this repository by its immutable IDs, the workflow file, and its context:

| Role (stack output) | Workflow | Accepted `sub` | Grants | Where its ARN goes |
|---|---|---|---|---|
| `sched-github-deploy` (`GitHubDeployRoleArn`) | `.github/workflows/deploy.yml`, run by hand from `main` | `repo:nick-delgado@25354284/serverless-ai-scheduling@1391507382:environment:dev:job_workflow_ref:nick-delgado/serverless-ai-scheduling/.github/workflows/deploy.yml@refs/heads/main` (exact) | What `scripts/deploy.sh` and `scripts/deploy-web.sh` use, every write scoped to `dev`: drive `sched-dev-*` stacks (no `DeleteStack`), pass `sched-cfn-exec`, the artifact bucket and `sched-dev-web-*`, SSM reads under `/sched/bootstrap/` and `/sched/dev/`. CloudFront invalidation covers every distribution in the account, and CloudFormation read and validate every stack, so those two reach other envs | `dev` environment secret `AWS_DEPLOY_ROLE_ARN` |
| `sched-github-evals` (`GitHubEvalsRoleArn`) | `.github/workflows/evals.yml` (#34) on same-repository pull requests | `repo:nick-delgado@25354284/serverless-ai-scheduling@1391507382:pull_request:job_workflow_ref:nick-delgado/serverless-ai-scheduling/.github/workflows/evals.yml@refs/pull/*/merge` (only the PR number varies) | `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on `sonnet-4.6` and `haiku-4.5` only | repository secret `AWS_EVAL_ROLE_ARN` |
| `sched-github-e2e` (`GitHubE2eRoleArn`) | `.github/workflows/e2e.yml` (#40) in the `e2e` GitHub Environment | `repo:nick-delgado@25354284/serverless-ai-scheduling@1391507382:environment:e2e:job_workflow_ref:nick-delgado/serverless-ai-scheduling/.github/workflows/e2e.yml@refs/heads/*` (the branch varies; the environment's branch rule decides which may run) | The `e2e` env's whole lifecycle except deleting it: drive `sched-e2e-*` stacks (no `DeleteStack`), pass `sched-cfn-exec`, the artifact bucket and `sched-e2e-web-*`, CloudFront invalidation, SSM reads under `/sched/bootstrap/` and `/sched/e2e/`, DynamoDB item calls on `table/sched-e2e-*`, and `seed-users.ts`'s Cognito calls on pools tagged `env=e2e`. Every write is scoped to `e2e`; CloudFront invalidation (every distribution) and CloudFormation read and validate (every stack) are account-wide, so they reach `dev` too, as Nick accepted on PR #224 (nothing that writes to or deploys `dev`) | `e2e` environment secret `AWS_E2E_ROLE_ARN` |

- **No permissions boundary** on these roles: the deploy and E2E roles need `iam:PassRole` on `sched-cfn-exec`, which the boundary denies. They are on `sched-cfn-exec`'s `ProtectBootstrapIdentities` deny instead, so no stack can change their trust or delete them. Sessions last at most an hour.
- **The eval role's `sub` is the same for every run of `evals.yml` on any same-repository PR**; only `job_workflow_ref` keeps other workflows out. Workflows from forked PRs get no OIDC token and no secrets, so they can't assume any role. The eval gate then fails closed when the PR changes a gated path, and passes without calling Bedrock when it doesn't (#34 r1/Q-2 (a)); Dependabot's runs get no repository secrets either, and are treated the same way. To evaluate such a PR, Nick pushes the branch to this repository (a fork) or a commit of his own to it (Dependabot; a re-run keeps the first run's privileges), or merges with an admin bypass after a local smoke run recorded in the PR.
- **Account ID in logs:** every credentials step sets `mask-aws-account-id: true`, so the account ID shows as `***` in every later log line. The role ARNs are secrets, so they're masked too.
- `scripts/bootstrap-template.test.ts` pins each role's audience and subject and its place on the deny list.

**Setting it up, in this order** (Nick; the `gh` commands need repository admin, and none of them prints a secret):

1. **Apply the bootstrap change** as in "Updating the bootstrap stack later", from the PR's branch checkout. It creates the OIDC provider; an account allows one provider per issuer, so the apply fails if one already exists (there was none on 2026-10-08: `aws iam list-open-id-connect-providers --profile sched-admin`). Before applying, set the Bedrock budget's service names: in **Billing and Cost Management → Cost Explorer**, group by **Service** over the months with live eval runs, and note every service name that carries Claude charges (third-party models may be listed under per-model names rather than "Amazon Bedrock"). Pass them on this apply by adding `--parameter-overrides BedrockBudgetServices="<name>,<name>"` to that command (the other parameters keep their values). Confirm the new budget's alert subscription if AWS sends one.
2. **Customize the repository's OIDC subject** to the claim keys `repo`, `context` and `job_workflow_ref`, keeping the immutable subject form (done on 2026-10-08, before the probe below; the second command checks it's still set):
   ```bash
   gh api -X PUT repos/nick-delgado/serverless-ai-scheduling/actions/oidc/customization/sub \
     -F use_default=false -f 'include_claim_keys[]=repo' -f 'include_claim_keys[]=context' -f 'include_claim_keys[]=job_workflow_ref'
   gh api repos/nick-delgado/serverless-ai-scheduling/actions/oidc/customization/sub   # shows use_default false, use_immutable_subject true and the three keys
   ```
3. **Create the `dev` GitHub Environment** (Settings → Environments → New environment): required reviewer Nick; deployment branches and tags: selected branches, `main` only. Add the deploy role's ARN as its secret, straight from the stack output:
   ```bash
   out() { aws cloudformation describe-stacks --profile sched-admin --region us-east-1 --stack-name sched-bootstrap \
     --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
   out GitHubDeployRoleArn | gh secret set AWS_DEPLOY_ROLE_ARN --env dev
   ```
4. **Create the `e2e` GitHub Environment** the same way, with the branch rule #40 needs (`main` only until then), and its secret: `out GitHubE2eRoleArn | gh secret set AWS_E2E_ROLE_ARN --env e2e`. #40 adds its own environment secrets (the demo password).
5. **Add the repository secrets:** `out GitHubEvalsRoleArn | gh secret set AWS_EVAL_ROLE_ARN`, then `gh secret set SES_SENDER` and `gh secret set SES_STAFF_RECIPIENT`, pasting each value from the main checkout's `.env` at the prompt (step 7). `scripts/deploy.sh` refuses to deploy `api` to `dev` without them.
6. **Merge the PR, then run the deploy workflow** (or disable it with `gh workflow disable deploy.yml` until you want CI deploys): `gh workflow run deploy.yml --ref main`, approve it under the `dev` environment, and watch it with `gh run watch`. A run before steps 3 and 5 stops at its first step with the missing secret's name and this section's name. Then **confirm the subject strings** (below) and post the run's link on #41.
7. **Require SHA pinning** for actions (Settings → Actions → General), now that every workflow pins its actions to commit SHAs.

**Confirm the subject strings.** On 2026-10-08, with the customization set, a scratch branch's probe workflow printed its tokens' `sub` claims (no AWS step; the branch, its draft PR and its `oidc-probe` environment were deleted afterwards). They have the form of the three strings above, with the same immutable prefix, the context, and `job_workflow_ref` written as `nick-delgado/serverless-ai-scheduling/.github/workflows/<file>@<ref>` (the journal entry quotes them). Only the workflow file and the ref differ, so each role's exact string is still confirmed by its workflow's first run:

- **Deploy:** the deploy workflow's "Show the OIDC subject" step prints the token's `sub` claim and nothing else. It must equal the deploy role's string above, character for character. If it doesn't, the next step fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`; correct the string in `infra/bootstrap/bootstrap.yaml` and `scripts/bootstrap-template.test.ts` in a follow-up PR and re-apply the bootstrap (step 1).
- **Eval gate and E2E:** #34's and #40's first runs confirm theirs the same way; copy the "Show the OIDC subject" step into those workflows before their first run. `evals.yml` has it, before its credentials step, and runs it only when the gate will call Bedrock (a gated path changed), so the first PR that changes one prints the subject; #34's own PR does. If the next step fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`, compare the printed subject with the eval role's string above and correct the bootstrap as for the deploy role. #40's run also confirms that Cognito honours the `env=e2e` tag condition for `AdminCreateUser`, `AdminSetUserPassword` and `AdminGetUser`; if it doesn't, the grant becomes `userpool/*` without the condition, which also reaches `dev`'s pool, and that change needs Nick's approval.
- **Both scripts under OIDC:** the workflow gives `AWS_PROFILE` a config-only profile (region only), so the AWS CLI and SAM CLI take the role's credentials from the environment (checked locally with both CLIs on 2026-10-08; the first run's log confirms it). The log shows `Deploying data auth api web to env 'dev' from main@<sha>`, the bucket names with `***` for the account ID, and then `published main@<sha>`.
- **Bedrock budget:** step 1 set its service names from past Claude spend. After the eval gate's first runs, check in Cost Explorer (group by Service) that its charges fall under those names; if a new one appears, re-apply the bootstrap with `--parameter-overrides BedrockBudgetServices="<name>,<name>"`.

## 6. Enable Bedrock model access

1. Console → **Amazon Bedrock** (us-east-1) → **Model catalog** (formerly **Model access**).
2. For **Claude Opus 5**, **Claude Sonnet 5**, and **Claude Haiku 4.5**: if this is the account's first Anthropic model, submit the one-time use-case form. Opus 5 has per-model access criteria; note what the console says.
3. **Accept each model's AWS Marketplace agreement. Being listed as "ACTIVE" isn't enough** (found in spike S-1). Bedrock accepts the agreement on the model's first call, but only when the caller has AWS Marketplace permissions. The `SchedDeployer` role has none, by design. So, **signed in as `sched-admin`**, send one message to each model in the Bedrock **playground** (select the model → "Open in playground" → send "hi"), or run:
   ```bash
   for m in us.anthropic.claude-opus-5 us.anthropic.claude-sonnet-5 us.anthropic.claude-haiku-4-5-20251001-v1:0; do
     aws bedrock-runtime invoke-model --profile sched-admin --region us-east-1 --model-id "$m" \
       --cli-binary-format raw-in-base64-out \
       --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}' /dev/null
   done
   ```
4. Verify that each model's agreement shows `AVAILABLE`. It may show `PENDING` for a few minutes:
   ```bash
   for m in anthropic.claude-opus-5 anthropic.claude-sonnet-5 anthropic.claude-haiku-4-5-20251001-v1:0; do
     aws bedrock get-foundation-model-availability --profile sched-dev --region us-east-1 --model-id "$m" \
       --query '[modelId, agreementAvailability.status, authorizationStatus]' --output text
   done
   ```
5. **Check the on-demand quotas.** New accounts can start low; spike S-1 was throttled after about 15 calls. Go to Console → **Service Quotas** → **Amazon Bedrock**, search for each model (e.g., "Claude Sonnet 5"), and note the requests-per-minute and tokens-per-minute values. Request increases if they're in single digits, because the eval harness makes thousands of calls.

## 7. Verify an SES identity (sandbox)

1. Console → **Amazon SES** (us-east-1) → **Identities** → **Create identity** → Email address. Use an address you control. It will be both the **sender** and the **staff recipient** for escalation emails.
2. Click the verification link in the email.
3. Leave SES in the **sandbox**. That's fine for the demo, since sandbox accounts can only send to verified addresses.
4. Put the address in the git-ignored `.env` of the main checkout as `SES_SENDER` and `SES_STAFF_RECIPIENT` (see `.env.example`). `scripts/deploy.sh` passes them to the `api` stack as NoEcho parameters, and refuses to deploy `api` to `dev` or `demo` without them. The repo is public, so the address never goes in a committed file, an issue or a PR.

## 8. Tell the agents

Reply in the Claude Code session with:
- the `sched-dev` profile working (output of `aws sts get-caller-identity --profile sched-dev`);
- the Bedrock model-access status for the three models;
- that the verified SES address is in `.env` (step 7). Don't paste the address itself.

---

## Documented non-CloudFormation exceptions

These are the only AWS changes made outside CloudFormation (CLAUDE.md, ADR-003):

| Change | Why not CloudFormation | Who |
|---|---|---|
| IAM Identity Center + permission sets | Organization-level setup; bootstraps the identities that run CloudFormation | Nick (console) |
| `sched-bootstrap` stack deploy | It *is* CloudFormation, but deployed with admin rights, once | Nick |
| Bedrock model access / use-case form | Console-only agreement flow | Nick |
| SES email verification click | Requires a human to click the email link | Nick |
| GitHub-side CI settings: the OIDC subject customization, the `dev` and `e2e` Environments, the secrets `AWS_DEPLOY_ROLE_ARN`, `AWS_E2E_ROLE_ARN` (environment), `AWS_EVAL_ROLE_ARN`, `SES_SENDER`, `SES_STAFF_RECIPIENT` (repository), and required SHA pinning | GitHub settings, not AWS resources; a workflow can't read the role ARNs from SSM before it has credentials | Nick ("CI credentials (GitHub OIDC)") |
| SPA asset upload (`aws s3 sync`) + CloudFront invalidation | Build artifacts, not infrastructure | Agents (`scripts/deploy-web.sh <env>`, after the env's auth and web stacks; builds with the Cognito IDs from SSM, see the `sam-deploy` skill), or the deploy workflow for `dev` |
| Demo user seeding (`AdminCreateUser`) | Passwords must not live in templates | Agents (`scripts/seed-users.ts`) |
| Re-sending failed escalation emails | Repairs data (a notification status) and sends email; not infrastructure | Agents or Nick, as `sched-dev` (`scripts/retry-escalations.ts`, below) |

## Teardown

Delete workload stacks in reverse order (`web` → `api` → `auth` → `data`) with the `sched-dev` profile. Delete `sched-bootstrap` last with `sched-admin`. The artifact bucket is retained, so empty and delete it manually if desired. Disable Identity Center only if nothing else uses it.

---

## Appendix: seeding an env's demo data

Two scripts, in this order. Both run as `sched-dev` (`aws sso login --profile sched-dev` first). Everything they write is synthetic (the `clinic-default` fixture).

1. **Cognito demo users:** `npx tsx scripts/seed-users.ts --env <env>` (passwords from the git-ignored `.env`). This writes `.seed/cognito-users.<env>.json`, which maps each fixture patient to their Cognito `sub`.
2. **Table data:** `npm run seed:data -- --env <env>` (or `npx tsx scripts/seed-data.ts --env <env>`).

What the data seed writes to the table named by SSM `/sched/<env>/data/table-name`:

- the 8 fixture providers;
- 30-minute slots, Mon–Fri 8 AM–5 PM clinic time, for **4 weeks starting today** (the clinic-local date in America/New_York);
- a `PATIENT#<sub>` profile for each patient in the mapping, and their fixture appointments. Every fixture patient ID becomes the patient's `sub`. Fixture patients without a mapping row are skipped, with their appointments, and their slots stay open.

Before writing, it checks that the mapping is for this env and for the env's current User Pool (SSM `/sched/<env>/auth/user-pool-id`). If the mapping is missing, or belongs to another User Pool, it stops and says to run `seed-users.ts` for this env. If the file isn't valid JSON or doesn't have the mapping's shape, it stops and says to fix or remove the file. A mapping for another env, one with no users, or a row whose `fixturePatientId` doesn't match its alias also stops it, with an error naming the problem.

**Re-running is safe.** A normal run only adds what's missing. It never overwrites an existing slot or appointment, including bookings the agent made since. It rewrites the provider and patient profiles with the same content, and a profile keeps its original `createdAt`. On a later day, it extends the window to 4 weeks from that day, and earlier slots stay. A BOOKED fixture appointment is added only if its slot isn't stored yet, so a patient added to the mapping later may get only their past and cancelled visits. Use `--reset` to get the full set.

**`--reset` deletes before it writes.** It deletes every item in the fixture providers' partitions (profiles and all slots, booked or not), and each mapped patient's profile and appointments, including the ones the agent made. Conversations are kept. It asks you to type the table name, or takes `--confirm <table-name>`. With neither (for example, no terminal), it refuses before touching the table. This deletes table data, so in a shared env (`dev`, `demo`) ask Nick first (CLAUDE.md).

Local runs (DynamoDB Local; no AWS calls):

```bash
DYNAMODB_ENDPOINT=http://localhost:8000 npx tsx scripts/seed-data.ts --env dev --table <local-table> --mapping <file>
```

`--table` is required when `DYNAMODB_ENDPOINT` is set. `--mapping` overrides the default `.seed/cognito-users.<env>.json`. The tests (`scripts/seed-data.test.ts`) run against DynamoDB Local with temporary mapping files. They're skipped locally when no endpoint answers, and required in CI.

---

## Appendix: re-sending failed escalation emails

`escalate_to_human` emails the front desk once and never re-sends (FR-034). The patient always gets the phone number, but if the email fails, staff never hear about the escalation. The escalation record then keeps a `FAILED` notification status, or stays `PENDING` if the function couldn't record the result.

**When to run it:**

- the CloudWatch alarm `sched-<env>-notification-failed` fired (metric `Sched/NotificationFailed`, dimension `Env`, written by the SES notifier for each failed send); or
- an escalation is stuck at `PENDING` (for example, the function timed out mid-turn, which the alarm doesn't see).

**How:**

```bash
npx tsx scripts/retry-escalations.ts dev --dry-run      # list what would be re-sent; sends nothing
npx tsx scripts/retry-escalations.ts dev
```

Run it from the main checkout, where `.env` holds `SES_SENDER` and `SES_STAFF_RECIPIENT` (or pass `--env-file <path>`). Sending needs `ses:SendEmail` on the sender and recipient identities, with the sender as the From address, which the `SchedDeployer` permission set (`sched-dev`) grants through its `SendAsVerifiedIdentity` statement (Nick's choice on #35). If the permission set hasn't been re-provisioned with that statement yet, the send fails with AccessDenied; the dry run works either way.

What it does:

1. **Finds** every escalation whose notification is `FAILED`, plus each `PENDING` one at least 10 minutes old (`--min-pending-age <minutes>`), with one Scan of the env's table (SSM `/sched/<env>/data/table-name`, or `--table`). Younger `PENDING` ones may still be sending, so it leaves them alone.
2. **Rebuilds** each email from the stored escalation, the patient's profile and the conversation's messages, with the tool's own load-and-send step. The transcript is the conversation as stored at retry time, not a copy of the first attempt's: it can include later messages, and messages expire after 30 days, so an older escalation goes out with an empty transcript.
3. **Re-sends** it through the SES notifier, then sets the notification to `SENT` with the new SES MessageId, or to `FAILED` with the error (email addresses redacted). One failure doesn't stop the others. The exit code is 1 if any failed, or if the run stopped on an error (for example, missing SES settings).

The output has only IDs, statuses and MessageIds. Run one at a time: two runs at once can both send the same escalation. Re-running is safe otherwise, since a `SENT` escalation is never picked up again. A line ending in `status not recorded` means the email went out but the status didn't change, so the next run sends it again. Set that escalation's status by hand, or accept the duplicate.

Local runs (DynamoDB Local; no AWS calls except SES):

```bash
DYNAMODB_ENDPOINT=http://localhost:8000 npx tsx scripts/retry-escalations.ts dev --table <local-table> --dry-run
```

The tests (`scripts/retry-escalations.test.ts`) run against DynamoDB Local with a recording notifier, so they never send email.
