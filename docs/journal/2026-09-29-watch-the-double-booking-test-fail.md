# 2026-09-29 — A double-booking test only counts once you've watched it fail

**Chapter:** 3. The walking skeleton
**Milestone:** M1
**Related:** #5, ADR-004, ADR-008, PRD NFR-008, #13, #15

## What happened

Issue #5 built the data layer that the tools and the eval harness use before DynamoDB exists. It has four parts:
- repository interfaces, one method per ADR-004 access pattern;
- an in-memory implementation;
- a shared contract suite that the DynamoDB implementation (#13) must also pass;
- a `Clock` seam and the `clinic-default` fixture.

The headline acceptance test comes from ADR-004: 10 parallel bookings of one slot must produce exactly 1 success. It passed on the first run. That was the problem. The in-memory store does its check and its write synchronously, with no `await` in between, so it can't race. A test that can't fail against this implementation says nothing about it.

## Why we chose what we chose

- **Break it on purpose.** The agent inserted one `await` between "is the slot OPEN?" and "mark it BOOKED". That's the read-then-write race CLAUDE.md rule 2 forbids. Three contract tests went red. The standalone count was 10 of 10 bookings "succeeding" on one slot. After reverting, it was 1 of 10. The DynamoDB implementation inherits these tests, so they've now been shown to catch the bug they exist for.
- **Expected outcomes are values; bugs are throws.** `book` and `reschedule` return typed results (`SLOT_UNAVAILABLE`, `APPOINTMENT_NOT_FOUND`, ...) that map one-to-one onto the tool error codes. Schema-invalid input throws, and the executor turns that into a generic `INTERNAL`.
- **Two decisions go past ADR-004.** Both are flagged for #13.
  - *Conversation ownership.* ADR-004 keys messages by conversation only. That would let a client that sends someone else's conversation ID read or extend their history. Each append now carries a condition on the patient's own previous message (seq n−1). The same condition also blocks gaps.
  - *Escalate at most once.* The `ESC#<createdIso>` sort key can't make "at most once per conversation" atomic. The interface enforces it, and we propose a fixed `ESC` key.

## What surprised us

- **The default fixture never actually crosses DST.** We assumed the four weeks from Monday Oct 5 contained the Nov 1 change. They do, but only barely. Nov 1 is the window's last day and a Sunday, so the last slot is Friday Oct 30, still on EDT. The DST tests build the fixture from Oct 26 instead. The converted UTC start shifts by an hour (Fri 8:00 AM ET is 12:00Z, Mon 8:00 AM ET is 13:00Z), and clinic hours stay 8:00–4:30 on both sides.

## Evidence

- `npm test -w packages/tools`: 132 tests pass, 55 of them the repository contract suite. The whole repo: 314.
- Injected race: 10/10 successes, with 3 contract tests failing. Reverted: 1/10, all green.
- Fixture: 8 providers, 6 patients, 2,880 slots (20 weekdays × 8 × 18), 4 booked. Maria's appointment matches the contracts example (`slot_lee_20261013T1830Z`).

## What's next

- #13 runs the same contract suite against DynamoDB Local. GSI1 reads are eventually consistent in real DynamoDB, so the "booked slot leaves the open-slot index" assertion may need a consistent-read path there.
- Decide whether the default fixture should be 5 weeks, so evals see post-DST slots.
