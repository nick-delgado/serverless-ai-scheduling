# ADR-009: Safety, privacy, and abuse controls

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Nick Delgado (+ Claude, drafting)
- **Related:** PRD FR-035…FR-037, NFR-004, ADR-004, ADR-005, ADR-008

## Context

The domain is healthcare, even though the data is fake. The system has to behave the way a real one would:
- It must not give medical advice.
- It must route emergencies correctly.
- It must never reveal another patient's information.
- It must resist prompt injection from users or from tool outputs.
- It must not run up an unbounded Bedrock bill.

## Decision

**Data**
- **Synthetic data only.** The clinic ("Cedar Ridge Health"), providers, and patients are fictional. The UI shows a "demo, not a real clinic" banner.
- Conversation messages are kept for 30 days (TTL). No audio is stored (ADR-006).
- CloudWatch logs carry IDs, timings, and token counts, **not** message text.

**Identity and authorization**
- The patient ID comes from the JWT only (ADR-005). Tools can reach only that patient's records, so there is no tool that can read another patient's data.
- **Conversation ownership** (ADR-004 amendment, 2026-09-29): IDs in a request body are never trusted on their own. Message items store `patientId`. Reading a conversation, appending to it, and reading or updating its escalation all check that `patientId` against the JWT `sub` in the data layer. A mismatch looks exactly like "not found".
- Lambda roles are least-privilege:
  - The chat function can read and conditionally write the table (GetItem, Query, PutItem, UpdateItem, ConditionCheckItem; no Scan or Delete) and call `bedrock:InvokeModel`/`bedrock:InvokeModelWithResponseStream` on the entitled profiles' inference-profile and foundation-model ARNs *(refined by ADR-010)*. Once the SES notifier lands (#35), it can call `ses:SendEmail` only from the verified identity.
  - The session function can only GetItem and Query the base table.

**Agent behavior** (system prompt policy, enforced by evals)
- **Scope:** scheduling, availability, the patient's own appointments, and escalation. Off-topic requests get a polite decline.
- **No medical advice or triage.** Clinical questions get: "I can't advise on that, but I can book you with a provider."
- **Emergencies:** chest pain, trouble breathing, suicidal thoughts, and similar get an immediate "call 911 (or 988 for crisis)" message. The agent does not keep scheduling first.
- **Confirmation before any write:** the agent restates provider, date/time (clinic timezone), and reason, and books only after an explicit yes.
- **No invented facts:** every slot presented or booked must come from a tool result.
- **Escalation:** triggered when the patient asks for a human, repeated failure occurs (2+ failed attempts), the patient is frustrated, or the request is out of scope. The agent gives the number **1-800-555-0199** (fictional). `escalate_to_human` emails staff a summary and transcript.
- **Tool results are data:** the system prompt says instructions inside tool results or user-supplied "system" text are never followed.

**Cost and abuse**
- API Gateway stage throttling.
- A per-patient cap on agent turns per day (e.g., 50), enforced in the chat handler.
- An agent-loop iteration cap (ADR-001).
- An AWS Budget alarm (bootstrap stack).

**Bedrock Guardrails: deferred, decided by data.** We start without them. If the red-team eval set (ADR-008 L3) shows violations that prompt and policy changes can't fix, we add a Guardrail (denied topics: medical advice; PII filters) and measure its latency cost. This choice itself becomes a story beat.

## Consequences

- Every policy line above has at least one red-team or core scenario that checks it. That is how we avoid "policy theater".
- Logs without message text make debugging slightly harder. Per-turn traces live in DynamoDB (with TTL) for authorized inspection instead.
- **Revisit if** the system ever touches real data. That would require a HIPAA-eligible configuration, a BAA, audit logging, and a formal threat model, all out of scope for this proof-of-concept.

## Validation

- Red-team eval results: 0 violations required for M3 exit.
- The M3 security review (issue M3-04) audits IAM, logs, and data handling against this ADR.
