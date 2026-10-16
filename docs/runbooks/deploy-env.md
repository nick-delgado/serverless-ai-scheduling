# Runbook: deploy a new environment

This deploys a complete environment, `sched-<env>-*`, in an AWS account that is already set up (`aws-setup.md`, steps 1–8), checks that it works, and tears it down when it's no longer needed. It's the procedure FR-050 asks for: a new environment from this runbook alone. An agent or Nick runs it, as `sched-dev`.

Region: **us-east-1** throughout. The commands are for bash or zsh (the macOS default shell). Every command runs from the root of the checkout you deploy (the main checkout or a worktree under `.worktrees/`); `scripts/deploy.sh` and `scripts/deploy-web.sh` deploy the checkout they live in.

## Which env

| Env | What it is | Teardown |
|---|---|---|
| `dev` | Shared, protected. The deploy workflow (`aws-setup.md`, "CI credentials (GitHub OIDC)") or an issue's own stacks | Never with `teardown.sh`; see "Teardown" |
| `demo` | Protected; the env reviewers see (#44) | Never with `teardown.sh`; see "Teardown" |
| `e2e` | #40's standing env for the Playwright journeys | Never; see `aws-setup.md`, "Appendix: end-to-end tests (the e2e env)" |
| anything else | Ephemeral, e.g. `pr52`: a rehearsal or a branch's experiment | `scripts/teardown.sh <env>` when done |

A name is lowercase, 2–16 characters, starting with a letter (`^[a-z][a-z0-9-]{1,15}$`). Before a first deploy, make sure the name is free; this prints nothing for a new env:

```bash
aws cloudformation describe-stacks --profile sched-dev --region us-east-1 \
  --query "Stacks[?starts_with(StackName, 'sched-<env>-')].[StackName,StackStatus]" --output text
```

If it prints stacks you didn't create in this task, stop and ask Nick. For `dev` and `demo`, never delete them to start again.

## Prerequisites

1. **Tools:** the AWS CLI, the SAM CLI and `cfn-lint` (`aws-setup.md`, step 1), `curl`, and Node 24 or later on the machine (`node --version`). `.nvmrc` says 24, the version CI uses, so with a version manager run `nvm use`; without one, Homebrew's current Node (26 on 2026-10-16) runs every step here. The Lambda runtime doesn't depend on it: the templates pin `nodejs24.x`, and esbuild bundles for `node24`.
2. **Dependencies:** `npm ci` in the checkout.
3. **Credentials:** `aws sso login --profile sched-dev`, then `aws sts get-caller-identity --profile sched-dev`. A session lasts 8 hours; every script stops with "missing or expired" when it ends.
4. **The main checkout's git-ignored `.env`** (`.env.example` lists the keys; values never go in a commit, an issue or a PR):
   - `SES_SENDER` and `SES_STAFF_RECIPIENT`, the verified SES identity (`aws-setup.md`, step 7). `deploy.sh` reads them from the deploying checkout's `.env`, then the main checkout's. `dev` and `demo` refuse to deploy the `api` stack without them; any other env deploys without escalation email and prints a note.
   - `DEMO_PASSWORD_<NAME>` for each patient to seed (at least 12 characters, with lowercase, uppercase and a number). Only patients with a password are seeded.
   - **For `demo`**, the patients' passwords live in a separate git-ignored `.env.demo` in the main checkout, with values different from `dev`'s (#42 r1/Q-4), so a `demo` password never opens `dev`. Nick creates it. It holds `DEMO_PASSWORD_*` only; the SES pair still comes from `.env`.
5. **A clean working tree** for the web step: commit first. `deploy-web.sh` refuses untracked or changed files.

In a worktree, set this once per shell; the seed step reads the main checkout's `.env` through it:

```bash
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
```

In the main checkout, `$main` is the checkout itself.

## Deploy

Each step prints a `date` stamp before and after, so the run's log gives the time-to-deploy (the step times and the total, from the first stamp to the smoke check passing).

```bash
env=<env>
date -u +%FT%TZ; scripts/deploy.sh all "$env"; date -u +%FT%TZ          # 1. stacks: data → auth → api → web
date -u +%FT%TZ; scripts/deploy-web.sh "$env"; date -u +%FT%TZ          # 2. build the SPA and publish it
date -u +%FT%TZ; npx tsx scripts/seed-users.ts --env "$env" --env-file "$main/.env"; date -u +%FT%TZ   # 3. Cognito patients
date -u +%FT%TZ; npx tsx scripts/seed-data.ts --env "$env"; date -u +%FT%TZ                           # 4. providers, slots, profiles
```

1. **Stacks.** `deploy.sh all <env>` validates, builds and deploys `data`, `auth`, `api` and `web` in that order, as the CloudFormation execution role. The `web` stack's CloudFront distribution takes the longest. An ephemeral env gets `DeletionProtection=disabled`; `dev` and `demo` keep it on. Overrides go after `--` (for example `-- DailyTurnCap=500`); `api` defaults to the `sonnet-4.6` profile and 50 turns per patient per day. From a branch other than `main`, a deploy to `dev` or `demo` prints a note that it is an unmerged branch.
2. **SPA.** `deploy-web.sh <env>` reads the env's Cognito IDs, bucket, distribution and domain from SSM, builds `apps/web`, syncs it to the site bucket and waits for the CloudFront invalidation. `--dry-run` prints the plan and changes nothing.
3. **Patients.** `seed-users.ts` creates a Cognito user for each `DEMO_PASSWORD_*` the env file sets (username `<first>.<last>`, for example `maria.santos`) and writes `.seed/cognito-users.<env>.json` (git-ignored) in the running checkout. It reads only the file `--env-file` names, which defaults to the running checkout's `.env`; a worktree has none, so pass the main checkout's. **For `demo`, pass `--env-file "$main/.env.demo"`.** Re-running is safe: existing users keep their `sub` and get the file's password again.
4. **Table data.** `seed-data.ts` writes the 8 fixture providers, 4 weeks of slots from today and each mapped patient's profile and appointments (`aws-setup.md`, "Appendix: seeding an env's demo data"). Run it from the same checkout as step 3, since it reads that checkout's `.seed/` mapping. Never pass `--reset` on `dev` or `demo` without Nick.

## Smoke check

An env counts as deployed when all of this passes (#42 r1/Q-3 (b)):

```bash
date -u +%FT%TZ
aws cloudformation describe-stacks --profile sched-dev --region us-east-1 \
  --query "Stacks[?starts_with(StackName, 'sched-$env-')].[StackName,StackStatus]" --output text   # four rows: CREATE_COMPLETE (or UPDATE_COMPLETE)
domain="$(aws ssm get-parameter --profile sched-dev --region us-east-1 --name "/sched/$env/web/domain" --query Parameter.Value --output text)"
for page in chat login; do curl -sI "https://$domain/$page" | grep -iE '^(HTTP/|content-type)'; done   # 200, text/html
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://$domain/api/chat" -H 'content-type: application/json' -d '{}'   # 401
npx tsx scripts/seed-users.ts --env "$env" --env-file "$main/.env" --verify    # one "verified" line per patient (.env.demo for demo)
```

- `/chat` and `/login` must be `200` with `content-type: text/html`. S3's `403` means the SPA's deep-link function or the publish failed.
- `POST /api/chat` without a token must be `401`. Anything else means the authorizer isn't in front of the function.
- `--verify` first runs the seed again (the patients print as `exists`, and their passwords are set to the file's again), then signs each one in with SRP and checks the token's `sub` against the mapping. It prints no token and no password.

Then **one signed-in turn**, typed in the deployed SPA by a person in a browser, or by an agent through its session's browser. An agent without a browser asks Nick to type the turn and post the reply's first line on the issue. Open `https://<domain>/login`, sign in as a seeded patient, and send "What times does Dr. Priya Lee have open next week?". Name a provider (or a specialty) and a week: an open question such as "What appointments are available next week?" gets a clarifying question back ("What kind of visit are you looking for?"), which offers no slot. The reply must offer at least one slot on a date inside the seed window (the 4 weeks from the seed day). A reply that ends in an error message, or offers no slot, fails the check. The account's Lambda concurrency quota is shared by every `sched-*` env, so a throttled turn or a 500 while another env is busy is retried once with the Retry button; a second failure is a defect. This is one Bedrock turn, a few cents. Stamp the time when the reply has arrived (`date -u +%FT%TZ`): that ends the time-to-deploy.

Record the result without passwords, tokens, email addresses or the domain: the stack statuses, the HTTP status lines, the `verified` lines and the reply's first line.

## Keeping a standing env seeded

The seed covers 4 weeks from the day it ran. For a standing env (`dev`, `demo`), re-run step 4 (`seed-data.ts --env <env>`, no `--reset`) before the window runs out: it only adds the missing slots and keeps every booking. Re-run step 3 only to add a patient or change a password.

## Teardown

**An ephemeral env** (not `dev`, `demo` or `e2e`):

```bash
scripts/teardown.sh <env>          # asks you to type the env name
scripts/teardown.sh <env> --yes    # agents, only once Nick has approved this env's teardown
```

It empties the env's site bucket, then deletes `web`, `api`, `auth` and `data` in that order, with their table data and users; the `web` stack's delete waits several minutes while CloudFront disables the distribution. It refuses `dev` and `demo`. Afterwards the describe command under "Which env" prints nothing. The `.seed/cognito-users.<env>.json` file stays in the checkout; a later deploy under the same name replaces its rows, because they belong to the old User Pool.

**`dev` or `demo`:** only when Nick asks, every time; this deletes the env's data and users. `teardown.sh` refuses them, so the steps are by hand, in this order (bash or zsh, as `sched-dev`):

```bash
env=<dev|demo>
export AWS_PROFILE=sched-dev AWS_REGION=us-east-1
scripts/deploy.sh data "$env" -- DeletionProtection=disabled     # 1. protection off, table
scripts/deploy.sh auth "$env" -- DeletionProtection=disabled     #    and User Pool
bucket="$(aws ssm get-parameter --name "/sched/$env/web/bucket-name" --query Parameter.Value --output text)"
[[ "$bucket" == sched-"$env"-web-* ]] && aws s3 rm "s3://$bucket" --recursive --only-show-errors   # 2. empty the site bucket (CloudFormation can't delete a full one)
role="$(aws ssm get-parameter --name /sched/bootstrap/cfn-exec-role-arn --query Parameter.Value --output text)"
for stack in web api auth data; do                                # 3. delete in reverse order
  aws cloudformation delete-stack --stack-name "sched-$env-$stack" --role-arn "$role"
  aws cloudformation wait stack-delete-complete --stack-name "sched-$env-$stack"
done
```

Step 2 is what `teardown.sh` does: it empties only a bucket named `sched-<env>-web-*`. If a `wait` fails, read the stack's events (`aws cloudformation describe-stack-events --stack-name sched-<env>-<stack>`) before going on. Leave `sched-bootstrap` alone.

**The whole account:** `aws-setup.md`, "Teardown".

## When a step fails

| Symptom | Fix |
|---|---|
| "missing or expired" credentials | `aws sso login --profile sched-dev`, then re-run the step |
| `deploy-web.sh` refuses a dirty tree | Commit (or remove) the changes, then re-run |
| `seed-users.ts` can't find `.env` | Pass `--env-file "$main/.env"` (or `.env.demo` for `demo`) |
| `seed-users.ts`: no users at all | The env file sets no `DEMO_PASSWORD_*`; for `demo`, ask Nick to fill `.env.demo` |
| `seed-data.ts`: the mapping is missing or for another User Pool | Run step 3 for this env, from the same checkout |
| A stack in `ROLLBACK_COMPLETE` on its first create | Read its events (`aws cloudformation describe-stack-events --stack-name sched-<env>-<stack>`); for an ephemeral env, `scripts/teardown.sh <env>` and deploy again; for `dev` or `demo`, ask Nick |
| A turn throttled or a 500 | Retry once; if `dev` or `e2e` is busy, wait and retry |
