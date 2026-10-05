# 2026-10-05 — A cut stream and a bare 5xx now offer Retry, and a buffered body without `done` is unreadable, not cut

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #138, [PR #161](https://github.com/nick-delgado/serverless-ai-scheduling/pull/161), #104, #160, PR #133 (decision `cd600b3/SPEC-4`), ADR-007 (2026-10-05 amendment), PRD FR-015

## What happened

When #27 built the chat page's error bubble, Nick held Retry back from two failures: an HTTP 5xx with no `error` event in the body (API Gateway's or CloudFront's own answer), and a stream that ends cleanly before its `done` or `error` event. A resend after either could store the patient's message twice. #104 removed that risk for a conversation the client can name: the server now recognises a resend by its `clientMessageId` and replays the stored reply or runs the interrupted turn once.

The agent widened the predicate in `useChat.ts`. It is now `isRetryableFailure`, which applies to a turn that failed without an `error` event. It offers Retry for a `ChatHttpError` with status 500 or above, for the new `ChatStreamEndedError`, and for anything that isn't a `ChatHttpError` or `ChatProtocolError` (a network failure). The 401 guard still runs first and signs the patient out. `streamClient.ts` now throws `ChatStreamEndedError`, a `ChatProtocolError` subclass, at its "ended before the reply was complete" check (Nick's r1/Q-2 (b)), so existing `toBeInstanceOf(ChatProtocolError)` assertions still hold. A 4xx without an event, including API Gateway's throttle 429, and a malformed or unreadable stream stay non-retryable.

Nick chose (r1/Q-1 (a)) to offer Retry on every turn, including a failed first turn whose failure named no conversation. That Retry resends without a `conversationId`, so the server stores the message again in a new conversation and counts a second turn, as a first-turn network failure already did. PRD FR-015 and the ADR-007 amendment state the exception, and #160 tracks the real fix: the server names the conversation before the agent runs.

## Why we chose what we chose

Nick's readiness answers settled the shape. These are the decisions the spec left open, each with the alternative it beat:

- **A buffered body without `done` or `error` stays non-retryable.** Our first test table put "a buffered array that ends without done or error" in the truncation row, and it went red: `parseChatResponseBody` in `@sched/contracts` rejects such an array before `readChatStream` reaches its own end-of-stream check, so the client throws "couldn't be read", not the truncation error. We kept that rather than turning the contract failure into a `ChatStreamEndedError`. The buffered fallback is read whole, so an array missing its terminal event is a complete body that breaks the contract, not a cut connection. A cut buffered body is invalid JSON, which assumption A-1 already lists as unreadable. The test moved to the "not a `ChatStreamEndedError`" table.
- **A blank body counts as cut, like an empty one.** The spec named the empty 200 body. A body of only whitespace reaches the same check, and we pinned it alongside rather than treating it as malformed.
- **The predicate checks `ChatHttpError` first, then `ChatStreamEndedError`, then the rest.** The subclass has to be tested before its parent's exclusion, and the 401 guard stays at the call site, ahead of the predicate, as A-3 asks.
- **`ChatProtocolError.name` is typed `string`.** That lets the subclass name itself `ChatStreamEndedError` in stack traces and test output. Keeping the literal type would have forced the subclass to keep the parent's name.
- **The "event after `done`" page test types the reply out.** With instant rendering, the turn has already ended when the protocol error arrives, so the `doneReceived` guard isn't what keeps the reply. Deleting it left that test green. With the typewriter running, the error lands mid-typing, and deleting the guard turns the test red.

## What surprised us

- The buffered-array case, above. The issue's parenthetical ("ended before the reply was complete") matched only the NDJSON path. The buffered path never gets that far.
- `failTurn`'s own `if (ended) return;` guard turns no test red when deleted (break B13 in the PR). In every test that fails a turn after it ended, the `doneReceived` check in the `catch` returns first, so the second guard never decides anything. It predates this issue, and we left it alone.

## Evidence

- The break table in the PR: 13 edits, from the `>= 500` threshold at both edges (500 and 499) to the subclass's parent class, each with the tests that went red.
- AC 1's check against #104's tests in `services/api/test/chat-turn.test.ts`: "replays an answered message's stored reply, without a model call, a counted turn, a trace or a second copy" and "after a failed first turn, names the new conversation on error; Retry runs the agent again without storing the message twice or counting a turn". Both send a `conversationId`. No test covers a resend without one, or one that arrives while the original is still running. The ADR-007 2026-10-04 amendment states the latter: whichever turn stores second gets the retryable 409.
- `npm run test:coverage`: 92 test files passed, 3 skipped. `npm run coverage:changed`: every added source line ran in a test.

## What's next

- #160: name the conversation before the agent runs, so a first-turn Retry continues it after a network failure, a bare 5xx or a cut stream.
- Nobody has checked live what API Gateway's response streaming sends when the Lambda crashes before its first write (a bare 5xx, or a cleanly ended 200), so we don't know how often the new branches fire in production.
