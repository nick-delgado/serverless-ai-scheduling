# 2026-10-20 — A reviewer can request a demo patient, and the bot check comes before anything is counted or created

**Chapter:** 6. What I'd do next
**Milestone:** M4
**Related:** #357 (first of two PRs), PR #366, #356, #44, ADR-003, ADR-004, ADR-005, ADR-009, PRD FR-001, FR-004, NFR-004

## What happened

Until now a reviewer got into `demo` only if Nick sent credentials, which the application materials must not carry. #357 lets a reviewer get a temporary, synthetic patient on their own, without giving up anything personal. Nick settled in r1/Q-2 that it ships as two PRs: this one covers the request page, the bot check, issuance, both caps, the privacy statement and the docs, and puts the bootstrap grants for both parts in one edit so Nick applies the bootstrap stack once. The expiry job, the revoke-all step and turning the page on for `demo` are the second PR. In this PR the page can be on only in an ephemeral env.

The agent built `POST /api/request-access`, the API's only route without the Cognito authorizer. The handler checks a Cloudflare Turnstile token first, then reserves a place (both caps and a registry entry in one `TransactWriteItems`), creates the Cognito user the way `scripts/seed-users.ts` does, and writes the `PATIENT#<sub>` profile and the entry's `sub` in a second transaction. The page shows the username, a generated password and a made-up name once, in component state only. The Cognito admin adapter moved out of `seed-users.ts` into `services/api/src/lib/cognito-admin.ts` so both callers share it, with a `deleteUser` for the failure path.

The route, its function and its log group exist only where the `api` stack's `RequestAccess` parameter is `on`. The stack publishes that to SSM, and `scripts/deploy-web.sh` reads it to build the SPA with or without the link. `scripts/deploy.sh` passes the Turnstile secret from the git-ignored `.env`, and refuses `RequestAccess=on` for `dev`, `demo` and `e2e` until the expiry job exists.

Nothing here has run against AWS or Cloudflare. The bootstrap apply, Nick's Turnstile keys and the live check on an ephemeral env are pending; the PR says so.

## Why we chose what we chose

Nick's answers on #357 (r1/Q-1 to Q-6, A-1 to A-19) are on the issue. The ones below are the agent's, where the issue was silent or two answers pulled apart, each with the alternative it beat.

- **The page switch is the parameter alone in this PR; `Env` being `demo` is the second PR's.** r1/Q-4 (a) says the page is on when `Env` is `demo` or `RequestAccess=on`, and r1/Q-2 (b) says it is never on `demo` in the first PR. A condition that already named `demo` would turn the page on at the first `demo` deploy, before accounts can expire. The second PR adds the `demo` clause. Departure from the letter of Q-4 (a), flagged in the PR.
- **`deploy.sh` refuses `RequestAccess=on` for `dev`, `demo` and `e2e`.** Q-2's edge says no env that keeps state issues an account before the expiry job exists. The refusal turns that sentence into a test (`deploy.test.ts`); the alternative, a note in the runbook, would let a typo break it.
- **The new error codes are their own enum, not additions to `ChatErrorCode`.** `RequestAccessErrorCode` has `BAD_REQUEST`, `BOT_CHECK_FAILED`, `CAP_REACHED` and `TRY_AGAIN`. `ChatErrorCode` is shared with the chat stream, the dashboard's per-code metrics and the SPA's error mapping; adding to it would touch all three for a route that has nothing to do with chat. A-6 said "an error code for the cap and the bot check"; this is the smaller blast radius for it.
- **An optional `TurnstileExpectedHostname`, empty by default.** r1/Q-1 (a) wants a hostname that isn't the env's to be rejected. The `api` stack deploys before the web stack that creates the CloudFront domain, so it can't resolve the domain, and Cloudflare's test secret keys report `localhost`. The parameter checks the hostname when Nick sets it; with it empty the check is skipped and Cloudflare's own hostname list on the widget is the guard.
- **The Turnstile site key comes from `TURNSTILE_SITE_KEY` (the environment, then `.env`), read by `deploy-web.sh`.** The issue says `deploy-web.sh` sets the build-time key but not from where. The key is public, but a per-env value that stays out of the repo can differ between `demo` and an ephemeral env. The alternative, an SSM parameter, would need a step to write it that the issue doesn't allow. A missing key with the page on refuses the build.
- **The registry entry's `username` is rewritten by `commit`.** After a random username clash the retry uses a new handle, and the entry would otherwise name an existing user that the second PR's job would delete. A failure between the reservation and `commit` can still leave the first handle on the entry; that is about 36^-8 per request and the ADR-004 amendment says the second PR should check an entry's `sub` before deleting.
- **`deleteUser` is in this PR, `globalSignOut` is not.** A-3's failure path deletes the user once, so the adapter needs `deleteUser` now; sign-out is the expiry job's. The bootstrap edit still carries all six actions (A-1), which the PR says are unused until the second PR.
- **`patientItem` is exported from `@sched/tools/dynamo`, `openSlotGsi1` is not yet.** A-6 asks for both, but the slot release is the expiry job's; exporting an unused function in the Eval-gated package would add no test. The second PR adds it.
- **The public route is a path-level `Fn::If` in the OpenAPI body, not a SAM `Api` event.** We tried the event first and transformed the template offline with SAM's translator: with an explicit `DefinitionBody` SAM leaves the paths alone and the route never appeared. `Fn::If` around the path survives the transform; whether CloudFormation accepts it at deploy is the live check's first job.
- **The cap message lives in `@sched/contracts` (`ACCESS_CAP_MESSAGE`), and the page renders the server's message plus a README link.** One string for the handler's response and the SPA's mock; the alternative, the page owning the text, would let the two drift.

## What surprised us

- **`sub` is a DynamoDB reserved word.** The first `commit` update, `SET sub = :sub`, passed every unit test with a fake `send` and failed on DynamoDB Local with "Attribute name is a reserved keyword". The fix is a name placeholder (`#sub`); the Local test is the only thing that could have caught it, which is the case for keeping those tests required in CI.
- **SAM does not add an `Api` event's path to an explicit `DefinitionBody`.** The function and its permission were generated, the route was not. We would not have seen it without running the transform offline (`samtranslator` from the SAM CLI's own Python), since `sam validate --lint` accepts the template either way.
- **Cloudflare's test secret keys return `hostname: "localhost"`.** A server that always checks the hostname rejects the documented test keys, which the live check on an ephemeral env uses. Hence the optional hostname.
- **The mutation tool's suggestions include statement reorders that change nothing** (the order of two hooks in a React component, for one). Those survive by design and are listed as such in the PR's table rather than "fixed" with a contrived test.

## Evidence

- Contracts, store, handler, bot check, identity and the Cognito adapter have their own test files in `services/api/test/`; the race for the last place on both caps is `access-store.local.test.ts` (DynamoDB Local), and the conflict path is `access-store.test.ts` with a fake `send` that throws a conflict-only `TransactionCanceledException` (A-15). On real DynamoDB a loser of a last-place race may get "try again" instead of the cap message; either way nothing is created, and no test here claims more.
- The Turnstile contract was read from Cloudflare's documentation on 2026-10-20 ("Server-side validation": the `siteverify` URL, `secret` and `response`, a 300-second single-use token of at most 2048 characters, `timeout-or-duplicate` on a replay; "Testing": the dummy keys; "Plans": the Free plan; the Turnstile privacy statement for what the widget collects). Quotes are in the ADR-009 amendment.
- Bootstrap apply: `aws cloudformation deploy` is given no parameter overrides, so the spend backstop keeps its values; the AWS CLI reference says "If you're updating a stack and you don't specify a parameter, the command uses the stack's existing value".
- The seen-failing table, the coverage gate and the lint, typecheck and test results are in the PR description, for the commit it names.

## What's next

- The second PR: the expiry job (a SAM `Schedule` event, hourly), the revoke-all step, the live check that an expired account is deleted, and turning the page on for `demo` once #44's README has a contact line.
- Nick creates the Turnstile widgets, applies the bootstrap stack and approves the ephemeral env's teardown.
- Sharing the conflict-retry helpers between the turn store and the access store: to file.
