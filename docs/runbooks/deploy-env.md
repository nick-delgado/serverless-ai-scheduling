# Runbook: deploy a new environment

This deploys a complete environment, `sched-<env>-*`, in an AWS account that is already set up (`aws-setup.md`, steps 1–8), checks that it works, and tears it down when it's no longer needed. It's the procedure FR-050 asks for: a new environment from this runbook alone. An agent or Nick runs it, as `sched-dev`.

Region: **us-east-1** throughout. The commands are for bash or zsh (the macOS default shell). Every command runs from the root of the checkout you deploy (the main checkout or a worktree under `.worktrees/`); `scripts/deploy.sh` and `scripts/deploy-web.sh` deploy the checkout they live in.

## Which env

| Env | What it is | Teardown |
|---|---|---|
| `dev` | Shared, protected. The deploy workflow (`aws-setup.md`, "CI credentials (GitHub OIDC)") or an issue's own stacks. The request page is off (`deploy.sh` refuses it) | Never with `teardown.sh`; see "Teardown" |
| `demo` | Protected; the env reviewers see (#44). The request page is off until Nick turns it on with `-- RequestAccess=on` ("Reviewer access"), which `deploy.sh` allows only with the Turnstile secret and `TurnstileExpectedHostname`; any other `api` deploy, the emergency `EnvDailyTurnCap=1` included, leaves the page as it is | Never with `teardown.sh`; see "Teardown" |
| `e2e` | #40's standing env for the Playwright journeys; the request page is off, so its journeys don't change | Never; see `aws-setup.md`, "Appendix: end-to-end tests (the e2e env)" |
| anything else | Ephemeral, e.g. `pr52`: a rehearsal or a branch's experiment; the only kind, besides `demo`, that turns the request page on (`-- RequestAccess=on`, "Reviewer access") | `scripts/teardown.sh <env>` when done |

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

1. **Stacks.** `deploy.sh all <env>` validates, builds and deploys `data`, `auth`, `api` and `web` in that order, as the CloudFormation execution role. The `web` stack's CloudFront distribution takes the longest. An ephemeral env gets `DeletionProtection=disabled`; `dev` and `demo` keep it on. Overrides go after `--` (for example `-- DailyTurnCap=500`); `api` defaults to the `sonnet-4.6` profile, 50 turns per patient per day and 200 turns per env per day ("Daily turn caps" below). From a branch other than `main`, a deploy to `dev` or `demo` prints a note that it is an unmerged branch.
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

## Daily turn caps

Two caps count new turns per clinic-local day (ADR-009 and its 2026-10-20 amendment). Both are `api` stack parameters, counted together before any model call; a repeat or re-run of a stored message counts against neither.

| Cap | Parameter | Default | Who overrides it |
|---|---|---|---|
| One patient's turns | `DailyTurnCap` | 50 | `e2e` passes 500 |
| The whole env's turns, across patients | `EnvDailyTurnCap` | 200 (`demo`'s value; every env is capped unless it overrides) | `e2e` passes 1000; a live check passes 2 |

- **Set or change a cap** by deploying `api` with the override: `scripts/deploy.sh api <env> -- EnvDailyTurnCap=<n>`. An ephemeral env takes it on `deploy.sh all <name> -- EnvDailyTurnCap=2`.
- **A cap persists.** `sam deploy` marks every template parameter that `--parameter-overrides` doesn't name as "use previous value" (`samcli/lib/deploy/deployer.py`, `create_changeset`), so a later deploy without the override keeps the stack's value. A parameter the stack doesn't have yet (the first `api` deploy after #356) takes its template default, so `demo` starts at 200 with no override. Check what a stack holds: `aws cloudformation describe-stacks --profile sched-dev --region us-east-1 --stack-name sched-<env>-api --query "Stacks[0].Parameters"`.
- **What a patient sees.** Over their own cap: "You've reached today's message limit for the assistant" with the front-desk number and hours. Over the env's cap: "This demo has reached today's limit for the assistant. Please try again tomorrow, or see the project's README on GitHub to contact its author." No front-desk number. Both are an error bubble with no Retry (HTTP 429, `RATE_LIMITED`, `retryable: false`); the patient's message wins when both are reached. Until #44 adds a contact line, the README has none, which is fine while Nick hands out access himself.
- **Both reset at midnight Eastern** (the clinic-local date). There is no reset command: to let reviewers in sooner, raise `EnvDailyTurnCap` for the day with the command above and lower it again after. Counters expire two days after their day.
- **Cost bound.** A short Sonnet 4.6 turn cost about $0.01 and a tool-heavy one several times that (an estimate, not a measurement): 200 turns is roughly $2 to $10 a day.

## The spend backstop (`demo` only)

Besides the daily caps, `demo` has a monthly backstop on voice (#356, ADR-009's second 2026-10-20 amendment). It lives in the bootstrap stack, not in an env's stacks, so no `deploy.sh` command sets it: Nick sets its threshold and target with the bootstrap apply (`DemoBackstopUsd`, default 10; `DemoTranscribeRoleName`, `demo`'s Identity Pool role), and the steps are in [`aws-setup.md`](aws-setup.md), "The demo spend backstop".

- **Redeploying `demo`'s `auth` stack** can replace the Identity Pool role the backstop targets. After such a deploy, run the standby check there; if the role's name changed, re-apply the bootstrap with the new one.
- **What a patient sees when it trips:** voice recording fails as a failed Transcribe connection does today; text chat is unaffected. Chat spend is bounded by the caps above, not by the backstop; there is no Bedrock backstop; to stop `demo`'s spend by hand see [`aws-setup.md`](aws-setup.md), "Stopping `demo`'s spend by hand".
- **Reset:** Nick reverses the action with `aws budgets execute-budget-action ... REVERSE_BUDGET_ACTION` (`aws-setup.md` has the commands). AWS's Budgets Actions blog says an action that applies a policy is reset at the beginning of each budget period, so voice should return on the first of the month by itself (not yet seen live: we haven't tripped it).

## Reviewer access (the request page, #357)

`/request-access` lets a reviewer get a temporary synthetic patient without anyone sending credentials (PRD FR-004; ADR-005, ADR-009 and ADR-004's amendments of 2026-10-20). It collects nothing: a Cloudflare Turnstile check and one button. The page, its function and an hourly expiry job that deletes each account after `RequestAccessExpiryHours` exist together, and exist only where an env passes **`-- RequestAccess=on`**: an ephemeral check env, and `demo` when Nick turns it on. `dev` and `e2e` stay off (`deploy.sh` refuses `-- RequestAccess=on` for them). A deploy that passes `-- RequestAccess=on` is refused without `TURNSTILE_SECRET` and without `-- TurnstileExpectedHostname=<domain>`; any other deploy neither asks for them nor changes the page.

**Keys (Nick creates them once per env).** In the Cloudflare dashboard, Turnstile, add a widget (Managed mode) with the env's CloudFront domain as its hostname. Put its two keys in the git-ignored `.env` (`.env.example` lists them): `TURNSTILE_SITE_KEY` (public; `deploy-web.sh` bakes it into the SPA) and `TURNSTILE_SECRET` (`deploy.sh` passes it to the `api` stack as the NoEcho parameter `TurnstileSecret`). For an ephemeral check env, Cloudflare's documented test keys need no dashboard: site key `1x00000000000000000000AA` with secret `1x0000000000000000000000000000000AA` always passes, and the secret `2x0000000000000000000000000000000AA` always fails ([Cloudflare, "Testing"](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)). Never use them on an env that matters: anyone passes.

**Turn it on** (ephemeral env `<name>`):

```bash
export TURNSTILE_SITE_KEY=<site key> TURNSTILE_SECRET=<secret>     # or put them in .env
scripts/deploy.sh all <name> -- RequestAccess=on TurnstileExpectedHostname=example.com   # api publishes /sched/<name>/api/request-access = on; the test keys report example.com
scripts/deploy-web.sh <name>                                       # builds with VITE_REQUEST_ACCESS=on and the site key
```

`deploy-web.sh` reads the SSM value (a missing parameter reads as off) and refuses to build with the page on and no site key. Off, the sign-in page has no link, `/request-access` is the not-found page, and `POST /api/request-access` doesn't exist (API Gateway's own 403).

| Setting | Parameter | Default | Notes |
|---|---|---|---|
| Accounts issued per clinic-local day | `RequestAccessDailyCap` | 10 | at least 1; resets at midnight Eastern |
| Accounts in the registry at once | `RequestAccessActiveCap` | 5 | at least 1; "active" is listed in the registry, from the moment a request reserves its place until the expiry job removes the entry |
| Hours before an account is due for deletion | `RequestAccessExpiryHours` | 24 | at least 1; recorded in the registry and shown to the reviewer; the hourly job deletes the account at most an hour after it is due |
| Hostname a token must be issued on | `TurnstileExpectedHostname` | empty in the template; `deploy.sh` refuses to deploy the page without it | `demo`: the env's CloudFront domain (SSM `/sched/demo/web/domain`); an ephemeral check env with Cloudflare's test keys: `example.com`, which they report (seen on a live check: `localhost` made every request a 403 `BOT_CHECK_FAILED`) |

Set them like the turn caps: `scripts/deploy.sh api <name> -- RequestAccessDailyCap=2 RequestAccessActiveCap=2 RequestAccessExpiryHours=1`. They persist across later deploys (`aws cloudformation deploy` and `sam deploy` use the stack's existing value for a parameter the command doesn't name), so a later `deploy.sh api <name>` without `-- RequestAccess=on` keeps the page on, and `RequestAccess=off` turns it off. The secret is kept the same way: `TurnstileSecret` is a NoEcho parameter, and a deploy with no `TURNSTILE_SECRET` (environment or `.env`) leaves it out of its overrides, so SAM CLI marks it "use previous value" (`merge_parameters` in `samcli/commands/deploy/deploy_context.py`, SAM CLI 1.166.2: every template parameter the command doesn't name gets `UsePreviousValue`, with no exception for `NoEcho`) and the stack keeps it; it is never blanked. A deploy that does have the secret passes it, which refreshes it. `TurnstileExpectedHostname` persists like the caps.

**What a reviewer sees.** One button; then the username (`user-` and 8 characters), a generated password and a made-up patient name, once, with a copy button beside the username and another beside the password (each copies just that value), and a "Go to sign in" link that opens a plain `/login` in a new tab, so the account page stays open for the second field (the page doesn't sign them in; closing or reloading it loses the password). Past a cap: "Demo access requests have run out for now. Please contact Nick through the contact details in the project README." with a link, and nothing is created. A failed check says to try again. A reload shows the button again; the password isn't stored anywhere.

**Check it on an ephemeral env** (the live check of #357's first part). With the always-passes test keys, caps of 2 and the other steps of "Deploy" above (including seeding one fixture patient and the table data, so a signed-in turn works):

```bash
domain="$(aws ssm get-parameter --profile sched-dev --region us-east-1 --name "/sched/<name>/web/domain" --query Parameter.Value --output text)"
req() { curl -s -w '\n%{http_code}\n' -X POST "https://$domain/api/request-access" -H 'content-type: application/json' -d "$1"; }
req '{}'                                                    # 400 BAD_REQUEST: no token
req '{"turnstileToken":"XXXX.DUMMY.TOKEN.XXXX"}'            # 200: username, password, name, expiresAt (record none of them)
```

Sign the issued user in (the SPA, or `srpSignInSub` from `scripts/seed-users.ts`) and send one chat turn. Then redeploy `api` with the always-fails secret (`TURNSTILE_SECRET=2x0000000000000000000000000000000AA scripts/deploy.sh api <name>`) and request again: `403 BOT_CHECK_FAILED`, and the registry still holds one entry. Redeploy with the passing secret, request a second account (200), then a third: `429 CAP_REACHED` with the README message. Count the registry entries (always 2 after the cap), the users in the pool (`aws cognito-idp list-users` needs an admin profile; `SchedDeployer` is denied it) and the table's `ACCESS#` items:

```bash
table="$(aws ssm get-parameter --profile sched-dev --region us-east-1 --name "/sched/<name>/data/table-name" --query Parameter.Value --output text)"
aws dynamodb query --profile sched-dev --region us-east-1 --table-name "$table" --key-condition-expression 'PK = :p' \
  --expression-attribute-values '{":p":{"S":"ACCESS#ISSUED"}}' --select COUNT --query Count
aws dynamodb query --profile sched-dev --region us-east-1 --table-name "$table" --key-condition-expression 'PK = :p' \
  --expression-attribute-values '{":p":{"S":"ACCESS#COUNT"}}' --query 'Items[].{sk:SK.S,issued:issued.N,active:active.N}'
```

Tear the env down with `scripts/teardown.sh <name>` once Nick approves; its users go with its pool.

**What is and isn't logged.** The request function logs the API Gateway request ID, an outcome (`issued`, `bot_check_failed`, `bot_check_unavailable`, `capped`, `try_again`, `bad_request`, `error`; `bot_check_unavailable` on every request means the secret or Cloudflare is the problem, `try_again` is a passing transaction conflict) and the duration, for 14 days. It never logs or reads an IP address, a user agent, the token, a username or a password. The `api` stage and CloudFront have no access logs. Cloudflare sees the visitor's IP address and browser signals when the widget loads (ADR-009's amendment).

**Turn it on for `demo` (Nick; needs the keys above).** Prerequisites, in this order:

1. The bootstrap apply that widens `EventsSchedRules` to nine actions (`aws-setup.md`, "The apply for reviewer access"; Nick applied it on 2026-10-21), without which the `api` deploy fails with an AccessDenied on the schedule's rule.
2. A real Turnstile widget (Managed mode) whose hostname allow-list holds `demo`'s CloudFront domain, and its two keys in the main checkout's git-ignored `.env` as `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` (never Cloudflare's test keys on `demo`: anyone would pass). The README's contact line (#44) is what the "requests have run out" message points to, so write it before the page is public.
3. Then, from `main` (or the merged branch), with `aws sso login --profile sched-dev`:

```bash
host="$(aws ssm get-parameter --profile sched-dev --region us-east-1 --name /sched/demo/web/domain --query Parameter.Value --output text)"
scripts/deploy.sh api demo -- RequestAccess=on TurnstileExpectedHostname="$host"   # the page, its route and the hourly job; /sched/demo/api/request-access = on
scripts/deploy-web.sh demo                                           # rebuilds the SPA with the link, the page and the site key
```

The stack keeps `RequestAccess`, the hostname and the secret on later deploys, so a later `demo` deploy such as the emergency stop (`scripts/deploy.sh api demo -- EnvDailyTurnCap=1`, `aws-setup.md`) needs no keys and neither turns the page on nor off. Then check it on `demo` itself (the hostname and secret are real, so only a person passes the widget): the sign-in page links to the request page, a request issues an account that signs in, the hourly job's log group `/aws/lambda/sched-demo-api-request-access-expiry` has an `access-expiry` line each hour (`expired` 0 while nothing is due). **Turn it off** by revoking all accounts first (below), since the hourly job is what deletes them and it goes with the page, then `scripts/deploy.sh api demo -- RequestAccess=off` and `scripts/deploy-web.sh demo` (the SPA drops the link and the route). Accounts that were not revoked stay in the registry and the table while the page is off; they are deleted when the page is turned on again and the job next runs.

**The expiry job.** `sched-<env>-api-request-access-expiry` (`services/api/src/handlers/expire-access.ts`) runs from an EventBridge rule, `rate(1 hour)`, wherever the page is on. For each registry entry whose expiry is at or before now it (1) skips it, logged by request ID, unless the username starts with `user-`; (2) looks the Cognito user up and, only when its `sub` is the entry's, signs it out everywhere and deletes it; (3) deletes the patient's items (profile, appointments, conversations with their messages, escalation record and traces, turn counters) and puts every slot the patient held back to open; (4) removes the entry and frees its active place in one transaction. Any failure leaves the entry and the invocation reports an error (the function's `Errors` metric); the next run finishes it. What it leaves, on purpose: a token issued before the delete works for up to an hour, so a chat turn in that window can write new items, which expire on their TTL (30 days, ADR-009); staff emails an escalation sent stay in the mailbox; and point-in-time recovery keeps the deleted items restorable for 35 days.

Its log (14 days) carries request IDs, outcomes and counts only: one `access-expiry` line per run (`asOf`, `due`, `expired`, `skipped`, `failed`) and one `access-expiry entry` line per entry (`expired`, `released_unissued`, `already_released`, `skipped_prefix` or `failed`). `failed` on every run means a Cognito or DynamoDB call is failing (read the `access-expiry entry failed` line's error name); `skipped_prefix` means a registry entry names a username without `user-`, which nothing in the code writes: look at the entry before doing anything.

**Revoke all temporary accounts at once.** Run the job as of a time after every expiry. This needs `lambda:InvokeFunction`, which `SchedDeployer` doesn't have: use `sched-admin` (Nick):

```bash
aws lambda invoke --profile sched-admin --region us-east-1 --function-name sched-<env>-api-request-access-expiry \
  --cli-binary-format raw-in-base64-out --payload '{"asOf":"9999-12-31T23:59:59Z"}' /dev/stdout
```

It prints the summary (`due`, `expired`, `skipped`, `failed`); a `FunctionError` means some entry failed, so read the log and run it again until `failed` is 0. Afterwards the registry is empty and the active counter is 0 (the queries under "Check it on an ephemeral env"). Do this before `seed-data.ts --reset` on any env with the page on: the reset deletes only the fixture patients' appointments, so a temporary patient's booking would survive it while its slot is recreated open. The `asOf` field is read only from an operator's invocation: the schedule's event has none, so the hourly run always compares with the clock.

**Check the expiry on an ephemeral env** (the live check "an expired account is deleted", and the revoke-all step). Deploy as above but with `RequestAccessDailyCap=4 RequestAccessActiveCap=2 RequestAccessExpiryHours=1`, seed one fixture patient and the table data, then (shell variables hold the accounts' names; record none of them, and no password):

```bash
env=<name>
domain="$(aws ssm get-parameter --profile sched-dev --region us-east-1 --name "/sched/$env/web/domain" --query Parameter.Value --output text)"
table="$(aws ssm get-parameter --profile sched-dev --region us-east-1 --name "/sched/$env/data/table-name" --query Parameter.Value --output text)"
pool="$(aws ssm get-parameter --profile sched-dev --region us-east-1 --name "/sched/$env/auth/user-pool-id" --query Parameter.Value --output text)"
fn="sched-$env-api-request-access-expiry"
issue() { curl -s -X POST "https://$domain/api/request-access" -H 'content-type: application/json' -d '{"turnstileToken":"XXXX.DUMMY.TOKEN.XXXX"}'; }
registry() { aws dynamodb query --profile sched-dev --region us-east-1 --table-name "$table" --consistent-read --key-condition-expression 'PK = :p' \
  --expression-attribute-values '{":p":{"S":"ACCESS#ISSUED"}}' "$@"; }
active() { aws dynamodb get-item --profile sched-dev --region us-east-1 --table-name "$table" --consistent-read \
  --key '{"PK":{"S":"ACCESS#COUNT"},"SK":{"S":"ACTIVE"}}' --query Item.active.N --output text; }
inpool() { aws cognito-idp admin-get-user --profile sched-dev --region us-east-1 --user-pool-id "$pool" --username "$1" --query Username --output text 2>&1 | head -c 80; }
```

1. **An expired account is deleted.** Issue one account, note its username and `sub`, and look at what it has:

```bash
a="$(issue | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).username')"
sub_a="$(registry --query 'Items[0].sub.S' --output text)"
registry --select COUNT --query Count --output text; active                              # 1, 1
inpool "$a"                                                                              # the username: it exists
aws dynamodb query --profile sched-dev --region us-east-1 --table-name "$table" --consistent-read \
  --key-condition-expression 'PK = :p' --expression-attribute-values "{\":p\":{\"S\":\"PATIENT#$sub_a\"}}" --select COUNT --query Count --output text   # 1 (the profile)
```

   Optionally sign in as it and ask the assistant to book an appointment (one Bedrock turn), so the check also frees a slot; the unit and DynamoDB Local tests already cover that. Then run the job as of two hours from now, which is past the account's one-hour expiry (waiting instead: the account is due an hour after it was issued and the schedule runs every hour, so a real run deletes it within two hours of issue):

```bash
later="$(node -pe 'new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 19) + "Z"')"
aws lambda invoke --profile sched-admin --region us-east-1 --function-name "$fn" \
  --cli-binary-format raw-in-base64-out --payload "{\"asOf\":\"$later\"}" /dev/stdout     # due 1, expired 1, failed 0
```

   Expect: the registry is empty and `active` is 0; `inpool "$a"` prints a `UserNotFoundException`; the `PATIENT#<sub>` query above counts 0; `npx tsx scripts/seed-users.ts --env "$env" --env-file "$main/.env" --verify` still shows each fixture patient `verified`; the job's log has `access-expiry` with `expired` 1 (`aws logs filter-log-events --profile sched-dev --region us-east-1 --log-group-name "/aws/lambda/$fn" --filter-pattern '"access-expiry"'`).

2. **Revoke all, and the freed places.** Issue two more accounts (active 2 of 2), then a third: refused with the active cap's message and nothing created. Revoke all (the command under "Revoke all temporary accounts at once"), then issue once more: it succeeds, because the places are free again and the day's count (4 of 4 now) is the only thing left. The registry holds just that one entry, and `active` is 1.

Tear the env down with `scripts/teardown.sh <name>` once Nick approves.

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
if [[ "$bucket" != sched-"$env"-web-* ]]; then
  echo "stop: unexpected site bucket '$bucket' for '$env'; delete nothing" >&2
elif ! aws s3 rm "s3://$bucket" --recursive --only-show-errors; then   # 2. empty the site bucket (CloudFormation can't delete a full one)
  echo "stop: couldn't empty s3://$bucket; delete nothing" >&2
else
  role="$(aws ssm get-parameter --name /sched/bootstrap/cfn-exec-role-arn --query Parameter.Value --output text)"
  for stack in web api auth data; do                              # 3. delete in reverse order, stopping at the first failure
    if ! aws cloudformation delete-stack --stack-name "sched-$env-$stack" --role-arn "$role" ||
       ! aws cloudformation wait stack-delete-complete --stack-name "sched-$env-$stack"; then
      echo "stop: sched-$env-$stack didn't delete; read its events before going on" >&2
      break
    fi
  done
fi
```

The block stops where `teardown.sh` stops: it empties only a bucket named `sched-<env>-web-*`, deletes nothing when the name doesn't match or the bucket can't be emptied, and stops at the first stack that doesn't delete. It is stricter in one case: a missing `web/bucket-name` parameter, which `teardown.sh` takes as "no bucket", stops it too; check that the `web` stack is really gone before deleting the rest by hand. After a stack's `stop:` line, read its events (`aws cloudformation describe-stack-events --stack-name sched-<env>-<stack>`) before going on. Leave `sched-bootstrap` alone.

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
