# ADR-004: Data model — DynamoDB single-table design

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Nick Delgado (+ Claude, drafting)
- **Related:** PRD FR-014, FR-030…FR-034, FR-037, NFR-004, NFR-008, ADR-001, ADR-009, issues #5, #13, #56
- **Amended:** 2026-09-29 (conversation ownership, one escalation per conversation; see [Amendment](#amendment-2026-09-29-conversation-ownership-and-one-escalation-per-conversation)); 2026-10-02 (turn counters and traces; see [Amendment](#amendment-2026-10-02-turn-counters-and-traces))

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
| Message | `CONV#<convId>` | `MSG#<seq:06d>` | — | Anthropic content blocks as JSON, plus a trace ref; `expiresAt` = +30 days. **Amended 2026-09-29:** also stores `patientId` |
| Escalation | `CONV#<convId>` | `ESC#<createdIso>` | — | Reason, summary, email message ID. **Amended 2026-09-29:** SK is a fixed `ESC` |

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
| AP-8 | Append/read conversation messages | Query `CONV#id` ascending; put with `attribute_not_exists` on `MSG#seq` (append-only). **Superseded by the 2026-09-29 amendment** (ownership checks) |
| AP-9 | Record an escalation | PutItem `CONV#id / ESC#ts`. **Superseded by the 2026-09-29 amendment** (fixed `ESC` key) |

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

## Amendment (2026-09-29): conversation ownership and one escalation per conversation

The decision above stands: single table, same keys, and the same booking transactions. Building the in-memory repositories (#5, PR #55) found two gaps in the conversation and escalation rows. This amendment closes them, and the DynamoDB implementation (#13) builds on it.

**1. Conversation ownership (security).** Messages live under `CONV#<convId>` with nothing tying them to a patient. The chat handler receives `conversationId` in the request body, so any logged-in patient could send someone else's ID and read or extend that history. That's an insecure direct object reference, and it breaks ADR-009's rule that no patient can reach another patient's data.

- **Message items store `patientId`** (the Cognito `sub` of the patient who started the conversation) as a plain attribute.
- **Reads check ownership.** `listMessages(patientId, conversationId)` queries `CONV#id`, and if any item's `patientId` differs from the caller's, it returns nothing, exactly as for an unknown conversation. An existence oracle is also a leak, so "not yours" and "doesn't exist" look the same.
- **Appends are conditioned on ownership.**
  - Seq 0 starts a conversation. The transaction puts `MSG#000000` (`attribute_not_exists(PK)`) and the meta item `PATIENT#<sub> / CONV#<createdIso>#<convId>` (`attribute_not_exists(PK)`). Restarting an existing conversation fails on the message put, whoever owns it.
  - Seq n > 0 must follow this patient's message n-1. The transaction includes a `ConditionCheck` on `CONV#id / MSG#<n-1>` with `patientId = :sub`, and a put per new message (`attribute_not_exists(PK)`). A foreign conversation, an unknown one, and a gap all fail the check, and nothing is written.
  - Options were the meta item or message n-1. We chose **message n-1**: its key is computable from the batch, whereas the meta item's SK embeds `createdIso`, which the appender would first have to read. The n-1 check also enforces "no gaps" in the same condition.
- **Callers never trust a body `conversationId`** without going through these methods. The chat handler (#17) loads and appends only through the repository with the JWT `sub`. A red-team eval scenario (#33) sends another patient's conversation ID.

**2. At most one escalation per conversation.** A key of `ESC#<createdIso>` can't stop a second escalation atomically. Two concurrent `escalate_to_human` calls get different timestamps and both succeed.

- **The escalation key is a fixed `ESC` per conversation** (`CONV#<convId> / ESC`), written with `PutItem` and `attribute_not_exists(PK)`. The item stores `patientId`.
- If the condition fails, the existing record is returned. If it belongs to the caller, the result is `alreadyEscalated: true`. Otherwise the result is `NOT_OWNER` and nothing is shown.
- Reads and notification updates check `patientId` the same way (`updateNotification` is conditioned on `patientId = :sub`).

**Updated rows** (these replace the Message and Escalation entity rows and AP-8/AP-9 above):

| Entity | PK | SK | Notes |
|---|---|---|---|
| Message | `CONV#<convId>` | `MSG#<seq:06d>` | Content blocks as an opaque JSON string, `patientId`, `turnId`; `expiresAt` = message `createdAt` + 30 days |
| Conversation meta | `PATIENT#<sub>` | `CONV#<createdIso>#<convId>` | Unchanged; written in the same transaction as seq 0 |
| Escalation | `CONV#<convId>` | `ESC` | `patientId`, reason, summary, notification status and SES message ID |

| # | Pattern | Operation |
|---|---|---|
| AP-8 (write) | Append messages | `TransactWriteItems`: if n > 0, `ConditionCheck` `CONV#id / MSG#<n-1>` with `patientId = :sub`; `Put` each `MSG#<seq>` with `attribute_not_exists(PK)`; if n = 0, also `Put` the meta item with `attribute_not_exists(PK)`. At most 50 messages per call (`MAX_APPEND_BATCH`) |
| AP-8 (read) | Read a conversation | Query `CONV#id`, `begins_with(SK, "MSG#")`, ascending, consistent read; empty unless every item's `patientId = :sub` |
| AP-9 | Record an escalation | `PutItem` `CONV#id / ESC` with `attribute_not_exists(PK)`; on failure, return the existing item if `patientId = :sub`, else `NOT_OWNER` |

**Consequences.**
- The ownership check lives in the data layer, so no handler can forget it. That is the same "identity from the JWT" rule (CLAUDE.md rule 1) applied to conversation IDs.
- A conversation can't be continued after its latest message expires (TTL). That's acceptable at 30 days.
- The escalation record doesn't check that the conversation exists or belongs to the caller. Its `conversationId` comes from the handler, which has already loaded that conversation through the owned read.
- **GSI1 is eventually consistent on the real table** (#5 raised this). Right after a booking, AP-5 can still list the slot for a short while. That's safe: booking is conditioned on the base-table item (`status = OPEN`), so a stale listing ends in `SLOT_UNAVAILABLE`, never a double booking. AP-4 uses a consistent base-table query. DynamoDB Local updates GSIs synchronously, so the contract suite can't observe this lag.


## Amendment (2026-10-02): turn counters and traces

The chat handler (#17) adds two item types for ADR-009's daily turn cap and FR-051's per-turn trace. Both live in `services/api` (`lib/dynamo-turn-store.ts`), not in the tools' repositories, because no tool reads them.

| Entity | PK | SK | Notes |
|---|---|---|---|
| Daily turn counter | `PATIENT#<sub>` | `TURNS#<yyyy-mm-dd>` (clinic-local day) | `turns`; `UpdateItem` `ADD turns :one` with `attribute_not_exists(turns) OR turns < :cap`, so concurrent turns can't overshoot; `expiresAt` = two days after the day ends (UTC) |
| Turn trace | `CONV#<convId>` | `TRACE#<turnId>` | `patientId`, `outcome`, the `TurnTrace` as an opaque JSON string; `PutItem` with `attribute_not_exists(PK)`; `expiresAt` = turn start + 30 days |

Neither prefix collides with an existing query: patient queries use `APPT#` and `CONV#`, conversation reads use `MSG#`, and the escalation is the fixed `ESC` key. Traces hold tool inputs (patient free text), so they stay out of CloudWatch (ADR-009).
