# 2026-10-20 — The whole env gets its own daily turn cap, counted in the same transaction as the patient's

**Chapter:** 6. What I'd do next
**Milestone:** M4
**Related:** #356 (first of two PRs), PR #358, #44, #357, #273, ADR-009, ADR-004, PRD FR-015, FR-017, NFR-004

## What happened

Until now one patient was capped at 50 turns a day (`DailyTurnCap`, ADR-009), and nothing capped the env as a whole. The two budgets only send email, so a leaked password, or the self-serve access page (#357), would have kept spending every day until Nick read an alert. #356 adds two limits; Nick settled in r1/Q-1 that they ship as two PRs. This is the first: an exact, immediate env-wide cap in the chat handler. The spend backstop is the second.

The agent added `EnvDailyTurnCap` to the `api` stack (default 200, minimum 1, passed to the function as `ENV_DAILY_TURN_CAP`). The turn store now counts a new turn with one `TransactWriteItems` of two conditional updates, the patient's day item first and a new `ENV` / `TURNS#<day>` item second. If either condition fails, neither counter moves, so a turn one cap refuses uses up neither count, and there is still no read-then-write. A repeat or re-run of a stored message never reaches the store, so it counts against neither cap. An env-cap refusal is HTTP 429 `RATE_LIMITED`, not retryable, with its own text that points at the README and never at the front desk.

`e2e` passes `EnvDailyTurnCap=1000` beside `DailyTurnCap=500`, because the template's default of 200 would stop a day of suite runs.

## Why we chose what we chose

Decisions Nick settled on #356 (r1/Q-1, Q-2, Q-3, Q-7, A-1 to A-8) are on the issue. The ones below are the agent's, where the issue was silent, each with the alternative it beat.

- **One call counts both caps: `consumeDailyTurn(patientId, day, { patient, env })`.** The alternative, a second store method for the env counter called after the patient's, would let a turn the env refuses still use up the patient's count, which the issue forbids.
- **The result says which cap refused: `{ ok: false, refusedBy: "patient" | "env" }`.** A transaction returns no attributes, so the old `used` count is gone (A-2). The log carries `capRefusedBy` where it carried `turnsUsedToday`, because a refusal is the fact an operator wants.
- **A cancellation with `ConditionalCheckFailed` in either position is a refusal, even when the other item only conflicted.** A conflict on the patient's item with a failed condition on the env's reads as an env refusal and is never retried. The alternative, retrying until both items report cleanly, could spin on a cap that will not open.
- **A conflict-only cancellation is attempted at most 5 times (4 retries), with the backoff of the tools package, then rethrown (Q-7 (b)).** The copy is local, as the answer says. The turn then fails as any thrown store error does.
- **The env message is the same on every env.** "This demo has reached today's limit" is true wherever it shows (Q-3), and the SPA needs no change: it shows a non-retryable message as it is.
- **FR-017 gets the env cap too, not only FR-015's list of messages.** A-4 names FR-015; FR-017 is the PRD's "usage limits" row and would otherwise read as if the patient's cap were the only one. The agent added a sentence there and traceability rows for FR-015, FR-017 and NFR-004.
- **The ADR amendments need two edits outside the issue's list:** `docs/adr/README.md`'s two index rows, because `scripts/adr-history.test.ts` requires each amendment's date in the ADR's row.

## What surprised us

- **DynamoDB Local never reports `TransactionConflict`.** A-1 asked us to confirm that concurrent transactions on the env item can be cancelled with it. The agent sent 20 simultaneous turns from 20 patients at one env item on DynamoDB Local: all 20 counted, no cancellation at all (a scratch test against the store as committed in `2ceb9d5`, not kept; no result file recorded the run, so the count is the agent's report). That is what [the retry-path entry](2026-09-29-dynamodb-local-is-too-polite.md) found for bookings: Local doesn't produce the cancellation the real service does. So the retry is tested with a fake `send` that throws a conflict-only `TransactionCanceledException` and then succeeds, and the race test (N-1 of N used, two patients at once) shows exactly one counted whether or not a conflict occurred. The live check's turns were sequential, so it saw no `TransactionConflict` either; whether the real service cancels under concurrent turns on the env item is still unobserved.
- **The first transaction in `aws.local.test.ts` was no longer the booking's.** That test injects one `TransactionConflict` into the first transaction and expects the booking to retry once. The turn counter is now a transaction too, so it took the injected conflict (and its own retry absorbed it) and the booking's retry count read 0. The turn count moved after the booking in the test.
- **Our first mutation run read KILLED-OTHER on every row.** `npm test -w services/api` isn't recognised as Vitest by `npm run mutate`, so no failed-test names came back to match the `expect` lists. `npx vitest run --root services/api` is.

## Evidence

- Template: `EnvDailyTurnCap` default 200, `MinValue` 1, `ENV_DAILY_TURN_CAP` (`services/api/test/api-template.test.ts`, "caps the whole env at 200 turns a day unless it overrides").
- Race, on DynamoDB Local (`services/api/test/dynamo-turn-store.local.test.ts`): with the env at N-1 of N, two patients at once, exactly one counted, the other refused as `env`, and the refused patient's own counter unchanged.
- The seen-failing table, the coverage gate and the lint, typecheck and test results are in the PR description, for the commit it names.
- `dev`: `scripts/deploy.sh api dev` at `0de35f2` succeeded; `sched-dev-api` is `UPDATE_COMPLETE` with `EnvDailyTurnCap=200`, the template default.
- Live check, run by the orchestrating session on 2026-10-20 at about 13:45 ET against `0de35f2`, on the ephemeral env `cap356` (`scripts/deploy.sh all cap356 -- EnvDailyTurnCap=2`; four stacks `CREATE_COMPLETE`; two seeded patients). Three new turns, sequentially: patient A got HTTP 200 with a reply, patient B got HTTP 200 with a reply, and patient A's second turn got HTTP 429 with an `error` event `RATE_LIMITED`, `retryable: false`, the env-cap text and no front-desk number. A scan of the table's `TURNS#` items afterwards: the env item `TURNS#2026-10-20` had turns=2 (`ENV_TURN_COUNTER`) and each patient's had turns=1, so the refused turn used up neither the env's count past 2 nor patient A's own. The SPA was not deployed to `cap356` (`deploy-web.sh` not run): the check called `/api/chat` through CloudFront. `cap356` was torn down on Nick's approval (`scripts/teardown.sh cap356`, all four stacks deleted).

## What's next

- The spend backstop (#356's second PR): a demo-only budget action, with its own amendment to ADR-009. **Later (2026-10-20):** it shipped for Transcribe only, with no Bedrock backstop; see [the spend backstop covers voice, not Bedrock](2026-10-20-the-spend-backstop-covers-voice-not-bedrock.md).
- #44 adds the README's contact line the env message points to. Until then the README has none, which is fine while Nick hands out access himself. **Later (2026-10-22):** the line is there (PR #368), and [reviewer access](../demo/reviewer-access.md) tells a reviewer what to do when the cap message appears.
- Sharing the conflict-retry helpers between the tools repositories and this store: to file.
