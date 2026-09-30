# 2026-09-29 — DynamoDB Local is too polite to test our retry path

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #13, #56, #5, ADR-004 (amendment 2026-09-29), ADR-009, PRD NFR-008, FR-037

## What happened

Issue #13 put the repository interfaces from #5 on the real single table. The shared contract suite now runs against DynamoDB Local, on a fresh table for every test, in CI as well as locally. Booking and rescheduling are single `TransactWriteItems` calls. Each business outcome (`SLOT_UNAVAILABLE`, `CONFLICT`, `SEQ_CONFLICT`, `PREDECESSOR_MISSING`) is read off *which item's* condition failed in the cancellation reasons.

The same PR landed the ADR-004 amendment (#56). Message items now store `patientId`. Reads check it, and appends are conditioned on message n-1 belonging to the caller. The escalation key became a fixed `ESC`, so "at most once per conversation" is a single `attribute_not_exists`, not a hope.

## Why we chose what we chose

- **Condition on message n-1, not on the conversation meta item.** The amendment allowed either. The meta item's sort key embeds the conversation's `createdIso`, which the appender doesn't have without an extra read. The key for n-1 is computable from the batch, and the same check also forbids gaps.
- **"Not yours" looks exactly like "doesn't exist."** A conversation that contains any item with another `patientId` reads as empty. We didn't return an ownership error, because that would tell a caller the ID exists.
- **Content is stored as one opaque JSON string.** #60 is making content blocks provider-neutral in parallel. A string round-trips byte-for-byte whatever the block shape becomes, and nothing in DynamoDB's type system touches it.

## What surprised us

- **DynamoDB Local never produced a `TransactionConflict`.** We logged every cancellation across a full contract run. There were 24, and every one was `ConditionalCheckFailed`: DynamoDB Local serializes transactions. The real service cancels a transaction that collides with another in-flight one, so our "retry on conflict only" path would have shipped untested. A test now injects two synthetic conflicts through SDK middleware and checks that the booking still lands exactly once.
- **Only the condition stops the race; the read in front of it doesn't.** We repeated #5's "watch it fail" exercise. We made the slot condition always true, while keeping the "is it OPEN?" read in front of it, and 5 of 10 parallel bookings "succeeded" on one slot. With `#status = :open` restored, it's 1 of 10.
- **The GSI can lag.** GSI1 is eventually consistent on the real table, so a just-booked slot can still show as open for a moment. DynamoDB Local updates GSIs synchronously and can't show this. It's safe, because booking conditions on the base item and a stale listing ends in `SLOT_UNAVAILABLE`. But the contract suite can't prove it, so the lag is documented in the ADR amendment instead.

## Evidence

- Contract suite on DynamoDB Local: 55 contract tests + 6 storage-level tests + 3 template-parity tests. It ran 6 times in a row with no flakes; the full repo run is 443 tests.
- Weakened condition: 5 of 10 parallel bookings succeed on one slot. Real condition: exactly 1.
- Cancellation codes over one run: `["ConditionalCheckFailed","None"]` ×15, `["None","ConditionalCheckFailed","None"]` ×3, `["ConditionalCheckFailed","None","ConditionalCheckFailed"]` ×3, three others ×1 each. There were no `TransactionConflict` codes.

## What's next

- #17 (chat handler) loads and appends history only through the repository, with the JWT `sub`. #33 adds a red-team scenario that sends another patient's conversation ID.
- If throttling or conflicts show up in dev, measure the retry count before tuning `MAX_ATTEMPTS`.
