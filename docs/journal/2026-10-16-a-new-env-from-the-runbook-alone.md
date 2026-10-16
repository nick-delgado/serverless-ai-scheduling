# 2026-10-16 — A new env from the runbook alone: five friction points, then 7 min 45 s from deploy to a signed-in turn

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #42 (M3-07), FR-050, ADR-003 (2026-10-03 amendment), ADR-009, ADR-010, security review F-19, #272, #270, #44, #43

## What happened

FR-050 asks that a new environment deploy "from the runbook alone". Until today `docs/runbooks/` had no section that did that: the procedure lived in the `sam-deploy` skill and `CLAUDE.md`. Nick's answers to the readiness review on #42 (r1) set the shape. The `task-worker` agent did the work and ran every AWS step as `sched-dev`. Nick renewed the SSO session when it expired and created `.env.demo`.

- **The runbook** is a new file, [`docs/runbooks/deploy-env.md`](../runbooks/deploy-env.md) (Q-2 (a)): prerequisites, `scripts/deploy.sh all <env>`, `scripts/deploy-web.sh <env>`, `seed-users.ts`, `seed-data.ts`, a smoke check, a top-up note for standing envs, teardown and a failure table. `aws-setup.md`, the `sam-deploy` skill and `CLAUDE.md` point to it.
- **"Deployed"** means all four stacks complete, `/chat` and `/login` return 200 `text/html`, an unauthenticated `POST /api/chat` returns 401, `seed-users.ts --verify` signs every patient in, and one availability turn typed in the deployed SPA offers slots (Q-3 (b)).
- **Three runs** (Q-1 (a)). A rehearsal on the ephemeral env `rb42` met the friction, and we fixed it in the runbook. `scripts/teardown.sh rb42 --yes` removed it. A timed redeploy of `rb42` from the fixed runbook passed with no new friction and was torn down again. Last, `demo` was deployed once from this branch, seeded with its own passwords from `.env.demo` (Q-4 (b)), checked the same way, and left standing.
- **`aws-setup.md`** got the runbook pass the comments asked for:
  - step 3 names the four Bedrock actions `SchedDeployer` grants: `bedrock:InvokeModel*` for Converse, and the `bedrock-mantle:*` pair, which nothing calls and #270 drops (F-19);
  - step 6 and step 8 cover the six entitled models, not Opus 5 and Sonnet 5 (Q-6 (b)), and step 6 says to leave model invocation logging off (#272);
  - the teardown section points to `teardown.sh` (A-2), and a new appendix documents `scripts/trace.ts`.
- **One table lookup.** The three operator scripts, `seed-data.ts`, `retry-escalations.ts` and `trace.ts`, now share one table lookup, `resolveTable` in `scripts/seed-data.ts` (Q-5 (a)).

## Friction the runs met

A friction point is a step where the operator needed something the runbook didn't say, where it was wrong or ambiguous, or where a command failed (E-1). All five came from the rehearsal on `rb42` (commit `b933a142d788`). The timed rerun and `demo` met none.

| # | Where | What happened | Fix |
|---|---|---|---|
| F-1 | Prerequisites | The runbook said Node 24 via `nvm use`. The machine has no version manager and runs Homebrew's Node 26. Every step worked on 26, since the Lambda bundle targets `node24` whatever runs esbuild. | `e144d95`: Node 24 or later; `.nvmrc` is CI's version |
| F-2 | Smoke check | The site-check loop was `for path in chat login`. In zsh, the macOS default shell, `path` is tied to `PATH`, so after the loop `curl`, `npx` and `sed` were "command not found". | `e144d95`: the loop variable is `page`, and the runbook names bash and zsh |
| F-3 | Smoke check | `seed-users.ts --verify` runs the seed again before it verifies: patients print as `exists` and their passwords are reset to the file's. The runbook implied a read-only check. | `e144d95`: says so |
| F-4 | Signed-in turn | "What appointments are available next week?" got a clarifying question back ("What kind of visit are you looking for, Maria?"), which offers no slot and so fails the check. | `e144d95`: the turn names a provider and a week ("What times does Dr. Priya Lee have open next week?") |
| F-5 | Signed-in turn | The runbook said "open … in a browser". The agent's session has no browser tool, and the runbook didn't say what to do then. The agent drove headless Chromium with the repo's Playwright from a scratch script outside the checkout, using the selectors in `apps/web/e2e/support/chat.ts`. | `8f1bf35`: the runbook names that route and Nick's fallback (r1/Q-3's edge) |

The agent's draft fixed one gap before any run (A-3, `4ab48fa`): `seed-users.ts` reads only the running checkout's `.env`, which a worktree doesn't have, so the runbook passes `--env-file "$main/.env"`, or `.env.demo` for `demo`.

## Time to deploy

Wall-clock times from the `date -u` stamps in each run's terminal log. A total runs from the start of `deploy.sh all` to the smoke check passing. SSO login and reading time aren't in them.

| Step | `rb42` rehearsal (`b933a142d788`) | `rb42` timed redeploy (`e144d95d7e19`) | `demo` (`e144d95d7e19`) |
|---|---|---|---|
| `scripts/deploy.sh all <env>` | 04:20:47 → 04:27:01, 6 min 14 s | 04:35:08 → 04:41:36, 6 min 28 s | 04:48:11 → 04:54:28, 6 min 17 s |
| `scripts/deploy-web.sh <env>` | 04:27:09 → 04:27:37, 28 s | 04:41:36 → 04:42:04, 28 s | 04:54:28 → 04:54:55, 27 s |
| `seed-users.ts` | 04:27:45 → 04:27:54, 9 s | 04:42:04 → 04:42:15, 11 s | 04:54:55 → 04:55:04, 9 s |
| `seed-data.ts` | 04:27:54 → 04:28:04, 10 s | 04:42:15 → 04:42:24, 9 s | 04:55:04 → 04:55:14, 10 s |
| Smoke check | failed (F-2), then passed by 04:29:44 after F-4's second turn | 04:42:24 → 04:42:53, 29 s | 04:55:14 → 04:55:40, 26 s |
| **Total** | 8 min 57 s, with the pauses to fix friction | **7 min 45 s** | **7 min 29 s** |

Each `teardown.sh rb42 --yes` took 4 min 40 s (04:30:07 → 04:34:47 and 04:43:18 → 04:47:58), most of it CloudFront disabling the distribution. Stacks take 80% of a deploy, and `web` is the slowest of the four.

## Why we chose what we chose

These are the decisions the spec left open, each with the alternative it beat.

- **The rehearsal env's name, `rb42`** (runbook, issue number), rather than a `pr<N>` name, since the PR didn't exist yet.
- **The resolver returns the region too**, not only the table name and endpoint that r1/Q-5 lists. `trace.ts` needs the region for its DynamoDB client, and a second copy of `vars.AWS_REGION ?? "us-east-1"` in each caller is the drift the resolver exists to stop. `retry-escalations.ts` still reads the region itself, because it builds its SES notifier before the table lookup.
- **The resolver builds the SSM client only when it reads SSM.** With `--table`, `retry-escalations.ts`'s test "uses --table without asking SSM" already pinned that no client is built. `seed-data.ts` reads the User Pool ID with the same client through a memoised factory, so it still builds one client for both reads, as its test pinned before.
- **The headless browser for the signed-in turn** (F-5), rather than asking Nick to type three turns. Q-3's edge says the agent sends the turn "in a browser if its session has one". A Playwright Chromium the agent starts is a real browser typing into the deployed SPA. The password went from the env file into a variable that was never printed, and the script printed only the greeting's and the reply's first lines. The script stayed in the agent's scratch directory, outside the repo. A committed helper would need its own tests, and Nick's own browser covers the same check.

What r1/Q-5's edge asked us to record: `retry-escalations.ts` still loads `.env` into `vars` before the lookup, and `trace.ts` doesn't. So a `DYNAMODB_ENDPOINT` set only in `.env` reaches `retry-escalations.ts` and no other script. The two `main` functions stay separate for that reason.

## What surprised us

- **A loop variable broke the whole shell.** zsh's `path` array mirrors `PATH`, so one innocent `for path in …` emptied the command search path for every later line of the block. Bash has no such tie, which is why the runbook's commands had looked fine on paper.
- **The agent was right to ask.** An open "what's available next week?" is a fair question for the agent to narrow. The smoke check needed a request specific enough to be answered in one turn.
- **The stale seed mapping needed nothing.** The timed redeploy reused the name `rb42`, so the checkout still held run 1's `.seed/cognito-users.rb42.json` for a deleted User Pool. `seed-users.ts` replaced its rows and `seed-data.ts` accepted the new pool, as the readiness review predicted.

## Evidence

- **Q-6 availability**, as `sched-dev` on 2026-10-16. `aws bedrock get-foundation-model-availability` printed `AVAILABLE AUTHORIZED AVAILABLE` for each of `anthropic.claude-sonnet-4-6`, `anthropic.claude-haiku-4-5-20251001-v1`, `amazon.nova-2-lite-v1`, `amazon.nova-pro-v1`, `openai.gpt-oss-120b-1` and `openai.gpt-oss-20b-1`. It prints the ID without `:0`. `get-model-invocation-logging-configuration` printed `None`, so logging is off.
- **Smoke check output for `demo`**, condensed: each `curl -sI` pair on one line, and five `verified` lines folded into one. The timed `rb42` run printed the same.

  ```text
  sched-demo-web	CREATE_COMPLETE
  sched-demo-api	CREATE_COMPLETE
  sched-demo-auth	CREATE_COMPLETE
  sched-demo-data	CREATE_COMPLETE
  HTTP/2 200 / content-type: text/html        (/chat)
  HTTP/2 200 / content-type: text/html        (/login)
  401                                          (POST /api/chat, no token)
    verified maria.santos: USER_SRP_AUTH ok, ID token sub matches
    (and the same for walter.haines, aisha.rahman, daniel.park, sofia.marquez, james.whitaker)
  reply first line: Here are the first five open slots for Dr. Priya Lee next week:
  reply second line: 1. Monday, October 19, 2026 at 8:00 AM ET
  ```

  The seed wrote `2900 item(s): 8 providers, 6 patients, 2880 new slots, 6 new appointments (window 2026-10-16 + 4 weeks)`, so 19 October is inside the window.
- **`demo` stays protected.** `sched-demo-main` reports `DeletionProtectionEnabled: true`, and its User Pool reports `ACTIVE`.
- **Seen failing.** The mutation table for the resolver and its three callers ran at `5e8c1f6`: 29 edits, all killed by the test each names. The first pass found that nothing pinned the default SSM client in `seed-data.ts` or `retry-escalations.ts`. The two tests at `5e8c1f6` spy on `SSMClient.prototype.send` for that, and the resolver's message test now matches the whole string.
- **Cost.** Four Bedrock turns on `sonnet-4.6`: two in the rehearsal (F-4's open question, then the named one), one in the timed run and one on `demo`. That's a few cents at the e2e suite's rate of about $0.01 a turn. The greeting is templated and calls no model. The ephemeral stacks stood for about 30 minutes in all, at about $0 idle.

## What's next

- `demo`'s seed window ends four weeks from today. Re-run `seed-data.ts --env demo` before then (the runbook's "Keeping a standing env seeded").
- #44: reviewer access to `demo`, and the credential process. The `demo` passwords live only in `.env.demo`.
- #43: `README.md`'s "Local development and deploys: *coming with M1*" can now link to `docs/runbooks/deploy-env.md`.
- #270: once the `bedrock-mantle:*` pair is dropped, step 3's summary drops it too.
