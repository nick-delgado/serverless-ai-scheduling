# 2026-10-07 — A reschedule that loses the race to its identical twin now answers already_rescheduled, and on DynamoDB Local it fails all three conditions

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #207, #77, PR #203, ADR-004 (AP-7), PRD FR-032, NFR-008

## What happened

Since #77 (PR #203), the repositories answer a reschedule into the slot the appointment already holds with the retry variant `{ ok: true, alreadyRescheduled: true, appointment }`, and `reschedule_appointment` turns it into `already_rescheduled: true` with `previous_start_local: null`. That only covered a retry that *read* the appointment after the first move committed. On DynamoDB, a retry that read it before the first move committed sent its transaction anyway, the transaction was cancelled on the appointment's condition, the repository returned `CONFLICT`, and the tool answered `INTERNAL`. Nick had deferred this, option (b) of #77's r1/Q-2, to its own issue, #207.

The agent (a delegated task worker) added a re-read to the `codes[2]` branch of the DynamoDB `reschedule` catch: one strongly consistent read of the appointment. If it is `BOOKED` in `newSlotId`, the call returns the retry variant with the appointment as re-read; anything else (a different slot, the old slot, not `BOOKED`, missing) stays `CONFLICT`. It never returns `RETRY`, and the new slot's and old slot's branches, `retrying`, `TOOL_ERROR_CODE_FOR` and the in-memory repository are unchanged.

Tests, as Nick settled them in the readiness review (r1 on #207):

- **Forced race (Q-1).** In `dynamo.test.ts`, a second client's middleware runs the identical move through the test's own repositories just before the call's `TransactWriteItems` is sent. The rival moves (`alreadyRescheduled: false`), the call answers the retry, the old slot is `OPEN` and the new slot is `BOOKED` by the appointment.
- **Free-running race (Q-1).** In the shared contract suite, `Promise.all` over two identical moves of `APPT.mariaLee` into `SLOT.leeTue2pm`: exactly one `alreadyRescheduled: false`, no failure, and `expectConsistent`. It runs on both repositories.
- **The two checks (Q-2).** A rival that moves the appointment to `SLOT.leeTue3pm` first (the call answers `CONFLICT`, the appointment stays there, `SLOT.leeTue2pm` stays `OPEN`), and a rival that moves it into `SLOT.leeTue2pm` and then cancels it with a raw `UpdateCommand` (`CONFLICT`). The existing cancel test stays as the plain cancel case, renamed to say so.

## Why we chose what we chose

Nick settled Q-1 (c), Q-2 (a) and assumptions A-1 to A-6 on #207 before work started. The agent decided these things the spec left open:

- **One rival helper, `withRival`, in `dynamo.test.ts`.** The middleware setup existed once for the cancel test and would have been written three more times. The helper runs the rival once, before the first transaction, and the existing cancel test now uses it. The `TransactionConflict` injection test keeps its own middleware, because it throws instead of running a writer; folding both shapes into one helper would have added a mode flag for one caller.
- **The helper records the cancellation codes.** A-6 asked the agent to confirm, from the forced test, that DynamoDB Local reports `ConditionalCheckFailed` at the appointment's index when all three conditions fail. Rather than check that once by hand, the forced race test asserts the codes are `["ConditionalCheckFailed", "ConditionalCheckFailed", "ConditionalCheckFailed"]`, so the premise is re-checked on every run against DynamoDB Local.
- **The retry answer has no `previous`, asserted.** The forced test checks that the result has no `previous` property, which is what lets the tool answer `previous_start_local: null` (A-4: the tool-level stubbed test pins that mapping; no new DynamoDB-backed tool test).

## What surprised us

The race fails *every* condition, not just the appointment's. By the time the losing transaction is evaluated, the winner has released the old slot (the old slot's condition fails), booked the new one (the new slot's condition fails) and moved the appointment (its condition fails). Only the order in which the catch inspects the codes, appointment first, puts the race in the branch that can recognise it. Had the catch checked the new slot's code first, the same codes would have read as `SLOT_UNAVAILABLE`, a different wrong answer. This is what DynamoDB Local showed; we did not check what the real service reports for each item, and on the real service two in-flight transactions can instead be cancelled with `TransactionConflict`, which retries from the top and meets the up-front same-slot check.

The free-running contract case, which Q-1 kept because "at once" should also mean literally at once, turned out to reach the new branch too: with the re-read removed, it failed on DynamoDB Local in the mutate run below, alongside the forced test. One run doesn't make it reliable (DynamoDB Local serializes transactions, so which call reads first is down to scheduling), which is why the forced test carries the evidence.

## Evidence

- Seen failing: `npm run mutate` with DynamoDB Local up, 6 edits, all KILLED in the test each edit's `expect` named: removing the re-read (forced race test; the contract case went red too), dropping the `newSlotId` check (the other-move test), dropping the `BOOKED` check (the moved-then-cancelled test), returning the stale read instead of the re-read (forced race test), disabling the handler's retry branch (the stubbed retry test), and mapping `CONFLICT` to `NOT_ALLOWED` (the mapping test). The table is in the PR.
- Eval: the L1 smoke suite on `sonnet-4.6` (`--suite smoke --mode l1 --trials 1`): `main` at `3b63dee` 8/8, pass@1 100%, tool-call accuracy 100%, 0 safety violations, $0.0403; this branch at `e2785af` the same, $0.0572. The evals run on the in-memory repositories, so they can't show this change; they show the tool's other answers didn't move.

## What's next

- Unchecked: whether the real service reports `ConditionalCheckFailed` for all three items in this race. Running the forced test against a table in an ephemeral environment would show it.
