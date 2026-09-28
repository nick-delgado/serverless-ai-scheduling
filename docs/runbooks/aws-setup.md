# Runbook: AWS account setup (one-time, human)

These steps give AI agents **scoped, short-lived** access to the AWS account and lay the foundation every stack depends on. Nick runs them once. After step 7, agents deploy everything else through CloudFormation.

**Access model**
- Two identities: an **admin** permission set used only by Nick for the bootstrap, and a **`SchedDeployer`** permission set used by agents. SchedDeployer can drive `sched-*` CloudFormation stacks and pass one role, `sched-cfn-exec`. That role creates the resources, and every workload role it creates must carry a permissions boundary.
- Everything is SSO, so there are no long-lived access keys on disk. The rationale is in ADR-003.

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

Before pasting the inline policy, substitute your account ID:

```bash
ACCOUNT_ID=123456789012   # your 12-digit account ID
sed "s/<ACCOUNT_ID>/$ACCOUNT_ID/g" infra/bootstrap/sched-deployer-policy.json | pbcopy
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
- SSM parameters under `/sched/bootstrap/`.

Confirm the budget alert subscription email if AWS sends one.

## 6. Enable Bedrock model access

1. Console → **Amazon Bedrock** (us-east-1) → **Model access**.
2. Enable **Claude Opus 5**, **Claude Sonnet 5**, and **Claude Haiku 4.5**. If this is the account's first Anthropic model, submit the one-time use-case form. Opus 5 has per-model access criteria; note what the console says.
3. Verify from the CLI (spike S-1 does this properly):
   ```bash
   aws bedrock list-foundation-models --profile sched-dev --region us-east-1 \
     --by-provider anthropic --query 'modelSummaries[].modelId'
   ```

## 7. Verify an SES identity (sandbox)

1. Console → **Amazon SES** (us-east-1) → **Identities** → **Create identity** → Email address. Use an address you control. It will be both the **sender** and the **staff recipient** for escalation emails.
2. Click the verification link in the email.
3. Leave SES in the **sandbox**. That's fine for the demo, since sandbox accounts can only send to verified addresses. Later, the `api` stack references this identity through a parameter.

## 8. Tell the agents

Reply in the Claude Code session with:
- the `sched-dev` profile working (output of `aws sts get-caller-identity --profile sched-dev`);
- the Bedrock model-access status for the three models;
- the verified SES email address.

---

## Documented non-CloudFormation exceptions

These are the only AWS changes made outside CloudFormation (CLAUDE.md, ADR-003):

| Change | Why not CloudFormation | Who |
|---|---|---|
| IAM Identity Center + permission sets | Organization-level setup; bootstraps the identities that run CloudFormation | Nick (console) |
| `sched-bootstrap` stack deploy | It *is* CloudFormation, but deployed with admin rights, once | Nick |
| Bedrock model access / use-case form | Console-only agreement flow | Nick |
| SES email verification click | Requires a human to click the email link | Nick |
| SPA asset upload (`aws s3 sync`) + CloudFront invalidation | Build artifacts, not infrastructure | Agents (`scripts/deploy-web.sh`) |
| Demo user seeding (`AdminCreateUser`) | Passwords must not live in templates | Agents (`scripts/seed-users.ts`) |

## Teardown

Delete workload stacks in reverse order (`web` → `api` → `auth` → `data`) with the `sched-dev` profile. Delete `sched-bootstrap` last with `sched-admin`. The artifact bucket is retained, so empty and delete it manually if desired. Disable Identity Center only if nothing else uses it.
