# 2026-10-19 — Escalations now expire after 30 days, and we wrote down that PITR keeps them for 35 more

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #271, PR #349, #39, ADR-004 (amendment of 2026-10-19), ADR-009 (amendment of 2026-10-19), PRD NFR-004, FR-034, `docs/research/security-review.md` F-10

## What happened

The M3 security review (#39) found that escalation items were the one record type with no `expiresAt`. Messages, conversation meta and turn traces expired after 30 days, but an escalation's `reason` and `summary` stayed in the table indefinitely. The readiness review asked four questions and one assumption needed checking; Nick took every recommendation, and the agent (a task worker) built this:

- **`escalationItem` writes `expiresAt`** = `createdAt` + 30 days, from `ESCALATION_TTL_DAYS = MESSAGE_TTL_DAYS` in `packages/tools/src/repos/dynamo/items.ts`. `expiresAtFor` takes the period as a required argument, and the message and conversation items pass `MESSAGE_TTL_DAYS`.
- **The docs say what the code can't:** an ADR-004 amendment (the expiry, the second-escalation gap, the retry behaviour, no backfill), an ADR-009 amendment (retention and PITR), the runbook's retry section, and the F-10 row of the security review.

## Why we chose what we chose

- **Expire at `createdAt` + 30 days through its own constant (r1/Q-1 (a)).** The alternatives were a longer period (b), expiry that follows the conversation by refreshing `expiresAt` on every append (c), and keeping escalations by design (d). (a) matches messages, needs no change to the append path, and keeps the staff email as the long-term record. (c) would have kept FR-034's one-escalation guard true as long as a conversation can be continued, but a `TransactWriteItems` `Update` on a missing item creates it, so it needs its own design. The price of (a) is that a conversation still being continued more than 30 days after its escalation can escalate a second time once DynamoDB deletes the first item. Nick accepted that, and the ADR says so.
- **State the retry behaviour; leave the script alone (Q-2 (a)).** The retry script finds items with a Scan, and a Scan still returns an expired item until DynamoDB deletes it. So a `FAILED` escalation is re-sent until its item is gone, and then it never is. Teaching the script to skip past-TTL items (c) would have added a selection rule to guard a window of a few days.
- **No backfill (Q-3 (a)).** The data is synthetic, and a backfill overwrites table data. Old items stay until someone deletes them.
- **Keep PITR at 35 days (Q-4 (a)).** We read AWS's PITR page (default `RecoveryPeriodInDays` 35, range 1 to 35) and `describe-continuous-backups` on `dev` reported `ENABLED` with 35. Shortening it (b) would be a data-stack change for synthetic data. ADR-009 now says, marked as our inference (the PITR page doesn't say it), that an item deleted by TTL can be restored for 35 more days, so a patient's `reason` and `summary` can outlive the escalation by about 65 days.
- **Check the deletion timing first (A-1).** AWS's TTL page says expired items "might be deleted by the system at any time, typically within a few days after their expiration" and tells callers to filter expired items out of Scan and Query results. We cited it in the ADR-004 amendment instead of assuming "at the second".
- **The agent's own choices, each with the alternative it beat.**
  - `days` is a required argument of `expiresAtFor`, not a default of 30 (the agent). With a default, a call that dropped `ESCALATION_TTL_DAYS` kept passing, because the two constants are equal; the mutation run showed it survived.
  - The test pins an exact epoch number for a `createdAt` with milliseconds, and the conversation meta's expiry gained an assertion (the agent). Before, nothing checked the meta item's `expiresAt`, so a change to its call was invisible.

## What surprised us

- **The mutation run found an equivalent mutant of our own making.** With a default of 30 on `expiresAtFor`, replacing the escalation's argument by nothing changed no behaviour, because `ESCALATION_TTL_DAYS` is 30. Removing the default made the argument load-bearing, and the replacement by 7 days is killed.
- **Nothing in the evals can change.** The eval harness runs on the in-memory repositories, which model no TTL. The Eval gate still runs because `packages/tools/**` is a gated path.

## What's next

`scripts/deploy.sh api dev` ships the change, since `items.ts` is bundled into the chat Lambda, after #251's latency run on `dev` finishes. Items already in `dev` and `demo` keep no expiry.
