# 2026-10-13 — The E2E suite reads the stream, not the reply, and the agent asked again even when told yes

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #40, PR #262, #41, #44, #251, PR #117, PRD FR-001–FR-003, FR-010, FR-012, FR-031, FR-034, NFR-006

## What happened

#40 asked for end-to-end tests of the deployed app, the one layer the eval harness never touches: a real browser, Cognito, CloudFront, the streaming API and the live model together. An agent (Claude, as #40's task worker) built it in `apps/web/e2e/`, with Playwright, against a new standing env, `e2e`, which it deployed itself (`scripts/deploy.sh all e2e -- DailyTurnCap=500`, then `scripts/deploy-web.sh e2e`).

- **The journeys:** login (FR-001–FR-003) and login → book on Chromium, WebKit and Firefox, then reschedule and escalation on Chromium. They sign in as Sofia Marquez, who nothing else uses on `e2e`, after one reseed per run.
- **The checks read the stream, not the reply.** Each booking sends a fixed script (a request naming the provider, the reason and the day; "The earliest of those works for me."; "Yes, please book it."), parses every turn's `/api/chat` stream with `@sched/contracts`, and passes when `book_appointment` runs exactly once, at or after the first "Yes" and never before, its chip shows, and the table holds exactly one new BOOKED appointment with that provider. Nothing reads the model's wording; the escalation test only looks for the front desk's number, a fixed fact.
- **The CI side:** `.github/workflows/e2e.yml`, dispatched by Nick from `main`, deploys the dispatched ref with the escalation email on, reseeds, runs the suite, and ends its log with the run's estimated Bedrock cost. It can't run before merge (a `workflow_dispatch` file must be on the default branch), so the PR's evidence is the agent's local run.
- **FR-010** was measured against `dev`, read-only, as Maria: 50 warm loads of `/chat` after 5 warm-ups.

## Why we chose what we chose

The decisions the spec left open, each with the alternative it beat:

- **The stream is teed inside the page's `fetch`, not read with Playwright's `response.text()`.** The first booking run failed in Chromium with `No data found for resource with given identifier`: Chromium can't hand Playwright the body of a streamed response the page has already read. Fulfilling the request through `page.route` would have buffered the whole turn and changed what the patient sees (the chips arrive while the turn streams). An init script tees `/api/chat` bodies inside `fetch`, so the app's half still streams; every browser gets the same code.
- **A throttled turn is retried with the app's Retry button, not failed.** The first full run lost the reschedule to `RATE_LIMITED` (Bedrock throttling, retryable): `sonnet-4.6` has 10 requests a minute for the whole account, and the suite sent 12 turns in 1.4 minutes, each several model calls. A retryable `RATE_LIMITED` is retried after 20, 40 and 60 s, at most three times, and stays one patient turn whose tools are every attempt's. The daily cap's `RATE_LIMITED` isn't retryable and still fails. Pacing every turn instead would slow every run to guard against an occasional throttle, and failing would make the suite's result depend on whoever else used the quota that minute.
- **The cost line comes from a reporter, not a global teardown.** Playwright prints its summary after the global teardown, so a teardown's line wouldn't end the log, which r1/A-8 asks for. A reporter listed after `list` prints after the summary, on a failed run too.
- **The live specs' mutation rows have no `expect`.** r1/Q-3 (a) asks for one edit per live spec "whose `expect` names it". `npm run mutate` names failed tests only for a Vitest command, so a Playwright command with an `expect` list always reads KILLED-OTHER. Each live edit's command runs only that spec, on Chromium, after a reseed, so its KILLED (no expect) row can only be that spec. The PR raises this under "Departs from or questions an owner decision".
- **Locally, only Sofia is seeded, as in CI**, and her password never lands in a file: it goes to `seed-users.ts` through the environment with `--env-file /dev/null`. Seeding from the main checkout's `.env` would have created all six demo patients on `e2e`.
- **No reseed wrapper.** r1/A-1 puts the two seed CLIs in the workflow as their own steps with `AWS_PROFILE` empty. The table name for `--confirm` comes from the AWS CLI with the config-only profile, because the CLI rejects an empty profile (`The config profile () could not be found`) where the JavaScript SDK skips it; the agent checked both locally with exported `sched-dev` credentials.
- **The journeys refuse `dev` and `demo`** (`E2E_ENV`), since they write to the table. Only the FR-010 config targets `dev`, and it sends no turn.
- **Booking day:** three clinic weekdays from the run's date; the reschedule moves Sofia's visit, nine weekdays out, to five. Both come from the seeded window, which starts on the run's clinic-local date (PR #117).

## What surprised us

- **The agent asked again even when the patient said yes early.** To see the confirmation check fail live, the agent changed the booking script's second message to "The earliest of those works for me. Yes, please book it." The edit survived: the agent ran no tool in that turn and booked only after the next "Yes". The traces show the same three-turn shape as the unedited run (`[find_providers, check_availability]`, `[]`, `[book_appointment]`). That's the confirmation rule holding under pressure, but it meant the check needed a deterministic break (the end state's provider) to be seen failing on the live stack.
- **The greeting is nowhere near its budget.** FR-010 allows 1.5 s at p95; on `dev` it was 291 ms. A probe run showed the greeting bubble lands about 2 ms after `POST /api/session` returns, so nearly all of it is the session call.
- **A whole run costs about 12 cents.** The green run was 13 turns for $0.1220 (list prices), throttle retry included.

## Evidence

- Full local run at `78bf287` against `e2e`, after one reseed: 14 passed in 1.8 min (Chromium, WebKit, Firefox, then `chromium-last`); `Estimated Bedrock cost (list prices): $0.1220 over 13 turns`. The reschedule's first turn was throttled once and passed on Retry after 20 s.
- Each booking's tools, per turn: `[find_providers, check_availability]` (WebKit and Firefox called `check_availability` twice), `[]`, `[book_appointment]`; each browser's new appointment was the provider's 8:00 AM slot on the booking day. The reschedule kept `appt_01JBXB1F7G8H9J0K1M2N3P4Q5R` and moved it to `slot_alvarez_20261020T1200Z`. The escalation's record was `SENT`.
- FR-010 on `dev`: n=50, p50 188 ms, p95 291 ms, max 311 ms, 0 discarded.
- All development runs on `e2e` together: $0.5348 over 52 turns (every `TRACE#` item in `sched-e2e-main`), against the 5 USD cap.
- Seen failing: the PR's `npm run mutate` tables, for the helpers (Vitest, offline) and for each live spec (Chromium against `e2e`, FR-010 against `dev`).

## What's next

- Nick's manual device and voice pass (`apps/web/e2e/MANUAL.md`) before merge.
- After merge, Nick's first `e2e.yml` dispatch: its OIDC subject and whether Cognito honours the `env=e2e` tag condition go on #40.
- #44 picks its demo patients elsewhere: Sofia belongs to the E2E suite on `e2e`.
