# 2026-10-02 — The first real Cognito sub wasn't a UUID, and every live chat turn was a 401

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #17 (S3-03), ADR-004, ADR-005, ADR-007, ADR-009, PRD FR-011–FR-015, FR-051, NFR-007

## What happened

The agent (Claude, working #17) replaced the walking-skeleton chat Lambda with the real one: `runAgentTurn` over `ConverseLlmClient`, a tool executor bound to the JWT `sub`, history loaded only through the owned `listMessages(patientId, conversationId)` read, a per-patient daily turn cap, and per-turn traces in DynamoDB. The tests ran it against in-memory repositories and a `ScriptedLlmClient`. All 31 passed on the first run, so we mutated the core (trusting the body `conversationId`, skipping the cap, storing the patient's message after the loop, dropping `text_reset`, logging the message text) until each guard had a test that went red. Three mutants survived the first pass and got tests: an escalation in a replaced conversation bound to the foreign ID, each operand of the throttling check, and a persist failure after the loop.

Then the first live request through CloudFront came back as the handler's own `401 UNAUTHORIZED`. The authorizer had accepted the token. The handler rejected it.

## What surprised us

The dev pool's `sub` for the test user has version digit `7` and variant digit `d`. That's 8-4-4-4-12 hex, but it isn't an RFC 9562 UUID, and `PatientId = z.uuid()` in `packages/contracts` enforces the variant. Every unit test, fixture and contract example used textbook v4 UUIDs, so nothing in 950+ tests could see it. It wasn't only the handler's problem: `createToolExecutor` and the repositories `PatientId.parse` the same value, so every real user would have failed one layer further down. The skeleton never noticed because it only checked that `sub` was truthy.

The fix is one line, `z.guid()`: it checks the hex shape and nothing about versions. A contract test pins a synthetic sub with the same shape.

The second surprise was smaller. Converse requires user and assistant messages to alternate. We store the patient's message *before* the loop runs, so a staff escalation's transcript includes it (#23) and a failed turn never loses it (FR-015). That means a throttled or crashed turn leaves history ending in a user message, and the next turn would be an invalid request. The handler now closes such a turn with a fixed assistant reply ("I couldn't finish my reply…"), both right after a failure and when it loads history that a crash left open. History stays append-only. The live smoke test hit exactly this: Bedrock throttled the second model call of the first turn, and the continuation turn after it went through cleanly.

## Why we chose what we chose

- **A foreign or unknown `conversationId` starts a new conversation**, rather than returning an error. "Not yours" and "doesn't exist" already look the same in the data layer (ADR-004 amendment). A fresh server-generated ID keeps the patient's message (FR-015) and never touches the other conversation. The `done` event tells the client which ID it got.
- **The daily cap is a conditional counter**, `PATIENT#<sub> / TURNS#<clinic day>`, with `ADD turns :one` under `attribute_not_exists(turns) OR turns < :cap`. Concurrent turns can't overshoot it. Rejected requests (401, 400) never count; a turn that fails after it started does.
- **Traces live under the conversation**, `CONV#<id> / TRACE#<turnId>`, with a 30-day TTL like the messages, because tool inputs carry patient free text (ADR-009). CloudWatch gets one line per turn: IDs, outcome, model calls, tool names and error codes, tokens, and timings.

## Evidence

- Live, through CloudFront on `sched-dev` (Sonnet 4.6, placeholder prompt): an owned continuation turn streamed 23 chunks with headers at 1.48 s and `done` at 2.45 s, reading 2,220 cached tokens. An unknown conversation ID was replaced and finished with `done`. A bad body got 400, and no token got the authorizer's 401. One turn was throttled (`ThrottlingException`, HTTP 429) after its tool ran; it stored 4 messages, including the closing reply.
- The stored rows for that conversation alternate `user`/`assistant` from `MSG#000000` to `MSG#000005`, all with the caller's `patientId`, plus one `TRACE#` row per turn. The day counter read 3, matching the three turns that reached the agent.
- Mutation pass: 25 mutants of the handler core, adapter and stores were all killed. One more was equivalent (a later guard still turned it into `INTERNAL`) and was replaced by a stricter mutant, which failed as expected.

## What's next

- #36 wires in the real system prompt (#16) and the SES notifier (#35). Until then, escalations are recorded with notification status `FAILED`.
- #12's seeding should be checked against a real `sub` (the test user has no `PATIENT#` profile yet).
