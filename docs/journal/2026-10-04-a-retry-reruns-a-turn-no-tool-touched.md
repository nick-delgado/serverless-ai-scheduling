# 2026-10-04 — A Retry re-runs a turn no tool touched, and replays one that a tool did

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #104, [PR #153](https://github.com/nick-delgado/serverless-ai-scheduling/pull/153), ADR-007 (2026-10-04 amendment), ADR-004, ADR-009, PRD FR-014, FR-015

## What happened

Until now `POST /api/chat` only logged the `clientMessageId` the SPA sends. A patient who tapped **Retry** after a model error had their message stored a second time and a second turn counted against the daily cap. Worse, when the *first* turn of a new conversation failed, the `error` event didn't say which conversation the server had just created, so the retry started yet another one, and a reload restored nothing.

The agent built de-duplication in the chat handler. The patient's stored message now carries its `clientMessageId`. A send whose ID matches the last patient message of the loaded conversation is a repeat. There are two kinds: a repeat of an **answered** message streams the stored reply again (no model call, no counted turn), and a repeat of an **interrupted** message runs the agent again on the history before it, without storing the message twice. The `error` event now carries the conversation ID whenever the conversation exists in storage, and the SPA keeps it the way it keeps the one from `done`.

## Why we chose what we chose

The interesting question was which failed turns count as "answered". Before this change, every failed turn got a fixed closing reply (`FALLBACK_MESSAGES.interrupted`: "I'm sorry, I couldn't finish my reply to your last message…") so that roles keep alternating for Converse. With that rule, a Retry after a throttled model call would have found an "answered" message and replayed the apology. The patient taps Retry and gets an apology back, with no second attempt.

Nick chose (readiness review r1, Q-1 (b)) to **stop storing the closing reply when a turn fails before any tool ran**. The turn ends at the patient's message, so a Retry re-runs it. A different, new message still closes it first, in the same append, so history stays append-only and alternating. A turn that failed **after** a tool ran (Q-3 (a)) keeps its closing reply and replays it. The tool may already have booked something, and running the agent again on top of half a turn is riskier than saying "please try again".

Decisions the spec left open, and the alternatives they beat:

- **A turn whose storing stopped after a tool result** (a crash between append batches, so no closing reply) gets the closing reply first, then replays it. It's treated as "failed after a tool ran" (Q-3). The alternative was a non-retryable `INTERNAL`, which would leave a patient who did nothing wrong unable to retry.
- **A stored reply with no text at all** (only `tool_use`, which shouldn't exist) answers `INTERNAL` rather than replaying an empty bubble.
- **The re-run's log line** gets `retry: "interrupted"` (and a replay's `retry: "answered"`, plus `replayed: true`), so a re-run that called the model can be told apart from a new message in the logs. The alternative was to log nothing new, which leaves a re-run's model call looking like a new message's.
- **"A failed first append"** (A-7) means the first append of a *new* conversation. A conflict while continuing an existing conversation still names it, because that conversation is stored. The alternative was to read it as the turn's first append in any conversation, which would leave a continued conversation unnamed on a conflict although it is stored.
- **The ADR change is a new amendment.** The issue asked for the 2026-10-03 amendment's Retries and Alternation bullets to be reworded. `docs/adr/README.md` allows no in-place correction, so the agent kept both bullets' wording, added italic pointers, and recorded the as-built behaviour in a new 2026-10-04 amendment. The alternative, rewording the bullets in place, would have broken the ADR's history rule.

In the PR review, Nick kept the first two as built (cf1c903/SPEC-2 (a)): a repeat whose stored turn stopped after a tool result closes that turn and replays the closing reply, the same rule as r1/Q-3 (a) for a turn a tool touched, and one that stopped at a `tool_use` with no text answers a non-retryable `INTERNAL`.

## What surprised us

The old test harness sent every message with the same `clientMessageId`. Once the server de-duplicated, every multi-send test would have silently turned into a replay test, and passed for the wrong reason. The readiness review caught this (A-9). The harness now mints a fresh ID per send and repeats one only when a test asks.

The daily cap had to move. It used to be consumed before the history was even read, but whether a send counts now depends on what's in the history. The cap now comes after the match, so a replay is served even to a patient who has reached the cap.

## Evidence

- `services/api/test/chat-turn.test.ts`, "handleChatTurn: retries (#104, FR-015)": 14 new cases. The breaks of `chat-turn.ts` and `history.ts` listed in the PR were each made on their own and seen failing.
- `apps/web/src/chat/useChat.test.tsx`: Retry after an error that names a conversation sends that ID, and the login session remembers it.

## What's next

- #138 checks Retry for a 5xx without an error event, and a truncated stream, against these tests.
