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

### Updating the bootstrap stack later

When a PR changes `infra/bootstrap/bootstrap.yaml`, re-apply it as admin. Existing parameter values (budget, email) are kept when you omit them:

```bash
aws sso login --profile sched-admin
aws cloudformation deploy --profile sched-admin --region us-east-1 \
  --stack-name sched-bootstrap --template-file infra/bootstrap/bootstrap.yaml --capabilities CAPABILITY_NAMED_IAM
```

When a PR changes `infra/bootstrap/sched-deployer-policy.json`, go to **IAM Identity Center → Permission sets → SchedDeployer → Inline policy**, paste the new version (with `<ACCOUNT_ID>` substituted, as in step 3), and then choose **Provision** (or "Update") on the account.

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
| SPA asset upload (`aws s3 sync`) + CloudFront invalidation | Build artifacts, not infrastructure | Agents (`scripts/deploy-web.sh`) |
| Demo user seeding (`AdminCreateUser`) | Passwords must not live in templates | Agents (`scripts/seed-users.ts`) |
| Re-sending failed escalation emails | Repairs data (a notification status) and sends email; not infrastructure | Nick (`scripts/retry-escalations.ts`, below) |

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
AWS_PROFILE=sched-admin npx tsx scripts/retry-escalations.ts dev
```

Run it from the main checkout, where `.env` holds `SES_SENDER` and `SES_STAFF_RECIPIENT` (or pass `--env-file <path>`). Sending needs `ses:SendEmail` on the identity. The `SchedDeployer` permission set (`sched-dev`) doesn't have it, so the send runs as `sched-admin`. The dry run works as `sched-dev`.

What it does:

1. **Finds** every escalation whose notification is `FAILED`, plus each `PENDING` one at least 10 minutes old (`--min-pending-age <minutes>`), with one Scan of the env's table (SSM `/sched/<env>/data/table-name`, or `--table`). Younger `PENDING` ones may still be sending, so it leaves them alone.
2. **Rebuilds** each email from the stored escalation, the patient's profile and the conversation's messages, exactly as the tool does. Messages expire after 30 days, so an older escalation goes out with an empty transcript.
3. **Re-sends** it through the SES notifier, then sets the notification to `SENT` with the new SES MessageId, or to `FAILED` with the error (email addresses redacted). One failure doesn't stop the others. The exit code is 1 if any failed.

The output has only IDs, statuses and MessageIds. Run one at a time: two runs at once can both send the same escalation. Re-running is safe otherwise, since a `SENT` escalation is never picked up again. A line ending in `status not recorded` means the email went out but the status didn't change, so the next run sends it again. Set that escalation's status by hand, or accept the duplicate.

Local runs (DynamoDB Local; no AWS calls except SES):

```bash
DYNAMODB_ENDPOINT=http://localhost:8000 npx tsx scripts/retry-escalations.ts dev --table <local-table> --dry-run
```

The tests (`scripts/retry-escalations.test.ts`) run against DynamoDB Local with a recording notifier, so they never send email.
