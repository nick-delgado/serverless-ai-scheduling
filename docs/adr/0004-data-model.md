# ADR-004: Data model — DynamoDB single-table design

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Nick Delgado (+ Claude, drafting)
- **Related:** PRD FR-014, FR-030…FR-034, NFR-008, ADR-001, ADR-009

## Context

The draft asked whether our data is "structured or unstructured". It is overwhelmingly **structured, with known access patterns**:
- Patients, providers, time slots, and appointments.
- Conversation messages: semi-structured JSON content blocks, always read by conversation ID.
- Escalation records.

Nothing needs full-text or vector search. There is no RAG in v1. Audio is never stored (ADR-006).

Requirements:
- **No double-booking**, even under concurrent requests or duplicate tool calls.
- Near-zero idle cost.
- A repository interface the eval harness can replace with an in-memory implementation.

## Options considered

1. **DynamoDB single table** (on-demand). Key-based access patterns, transactions with condition expressions, TTL, and zero idle cost.
2. **DynamoDB, one table per entity.** Simpler mentally, but more tables and IAM, and no gain for these patterns.
3. **Aurora Serverless v2 (Postgres).** Relational integrity and ad-hoc queries, but a VPC, a minimum capacity cost, and connection management from Lambda. That's overkill here.

## Decision

**A single DynamoDB table, `sched-<env>-main`**, on-demand, with point-in-time recovery on and TTL attribute `expiresAt`.

| Entity | PK | SK | GSI1PK / GSI1SK (sparse) | Notes |
|---|---|---|---|---|
| Patient profile | `PATIENT#<sub>` | `PROFILE` | — | `<sub>` = Cognito user `sub` (ADR-005) |
| Provider | `PROVIDER#<providerId>` | `PROFILE` | `PROVIDERS` / `<specialty>#<lastName>` | Lists providers by specialty |
| Slot | `PROVIDER#<providerId>` | `SLOT#<startIsoUtc>` | `OPEN#<specialty>#<yyyy-mm-dd>` / `<startIsoUtc>#<providerId>` | **GSI1 attributes exist only while the slot is OPEN**, so GSI1 is an index of open availability |
| Appointment | `PATIENT#<sub>` | `APPT#<appointmentId>` | — | Holds `providerId`, `slotStart`, `status`, `reason` |
| Conversation meta | `PATIENT#<sub>` | `CONV#<createdIso>#<convId>` | — | Lists a patient's recent conversations |
| Message | `CONV#<convId>` | `MSG#<seq:06d>` | — | Anthropic content blocks as JSON, plus a trace ref; `expiresAt` = +30 days |
| Escalation | `CONV#<convId>` | `ESC#<createdIso>` | — | Reason, summary, email message ID |

**Access patterns:**

| # | Pattern | Operation |
|---|---|---|
| AP-1 | Get a patient's profile | GetItem `PATIENT#sub / PROFILE` |
| AP-2 | List a patient's appointments | Query `PATIENT#sub`, `begins_with(SK, "APPT#")` |
| AP-3 | Get provider(s) by specialty | Query GSI1 `PROVIDERS`, `begins_with(<specialty>#)` |
| AP-4 | Open slots for a provider in a date range | Query `PROVIDER#id`, `SK between SLOT#from and SLOT#to`, filter `status = OPEN` |
| AP-5 | Open slots for a specialty on a day | Query GSI1 `OPEN#<specialty>#<date>` (sparse, so only open slots) |
| AP-6 | Book a slot | `TransactWriteItems`: update Slot (condition `status = OPEN`) → BOOKED, set `appointmentId`, **remove GSI1 attrs**; put Appointment (condition `attribute_not_exists(PK)`) |
| AP-7 | Reschedule | `TransactWriteItems`: release old slot (condition `appointmentId = :appt`), book new slot (condition `status = OPEN`), update Appointment (condition `status = BOOKED`, owned by patient) |
| AP-8 | Append/read conversation messages | Query `CONV#id` ascending; put with `attribute_not_exists` on `MSG#seq` (append-only) |
| AP-9 | Record an escalation | PutItem `CONV#id / ESC#ts` |

**Conventions:**
- Timestamps are stored in UTC ISO-8601. The clinic timezone (`America/New_York`) is config, and the agent always presents times in it.
- **Idempotency:** `book_appointment` first checks whether the patient already holds that slot. If so, it returns the existing appointment instead of failing. Duplicate tool calls are therefore harmless.
- **Repository interfaces** live in `packages/tools/src/repos/`. There are two implementations, DynamoDB and in-memory. **Both run the same contract test suite**, which keeps them equivalent.

## Consequences

- Double-booking is impossible at the database level. The agent can't "race" itself.
- The sparse GSI makes "what's open for dermatology on Tuesday?" a single query.
- Ad-hoc analytics would need exports (not needed for this proof-of-concept).
- **Revisit if** we add free-text clinic knowledge. That would suggest a RAG store (e.g., Bedrock Knowledge Bases) alongside this table, not instead of it.

## Validation

- Repository contract tests, including a concurrency test: 10 parallel bookings of one slot → exactly 1 succeeds.
- The eval graders assert end-state correctness against this model.
