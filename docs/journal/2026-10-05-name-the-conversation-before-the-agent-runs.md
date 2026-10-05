# 2026-10-05 — A new conversation is named before the agent runs, so a first turn's Retry continues it

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #160, [PR #174](https://github.com/nick-delgado/serverless-ai-scheduling/pull/174), #138 (PR #161), #104 (PR #153), ADR-007 (2026-10-05 amendment, #160), PRD FR-015, contracts v1.2

## What happened

Until now the client learned which conversation a turn belonged to only from its last event, `done` or `error`. When #138 started offering Retry for a cut stream and a bare 5xx, Nick accepted a known gap: a first turn that failed before naming its conversation was resent without a `conversationId`. The server then stored the patient's message a second time, in a second conversation, and counted a second turn.

The readiness review on #160 asked Nick two questions, and he took the recommended answer to both. The ID travels as a new NDJSON event, `{"type":"conversation","conversationId":"…"}` (r1/Q-1 (a)), and every turn that **starts** a conversation sends it (r1/Q-2 (a)). That includes a turn whose requested conversation read as empty (expired, or another login's), not only a turn that sent no ID.

The agent built it in four places:

- **Contracts v1.2:** `ChatConversationEvent`, a strict, non-terminal member of `ChatStreamEvent`.
- **The chat handler:** `#openTurn` marks a turn that opens a conversation. Right after the patient's message is appended, that turn writes the event before `runAgentTurn` is called. Because it is the first write, the response is 200 from then on, so on these turns a Bedrock throttle or another agent error arrives as 200 plus the `error` event, not 429 or 503. A turn that continues a stored conversation keeps its old statuses.
- **The hook:** it handles the event with the same `rememberConversation` that `done` uses, so the ID reaches the next send and the login session.
- **The MSW mock:** it sends the event first on the turns that start a conversation, after `latencyMs`, and the reply `firstEventMs` later.

ADR-007 gained an amendment, and FR-015 narrows its exception. A first turn still duplicates in one case: when it fails before the ID reaches the browser, through a network failure before any byte or a gateway's own 5xx.

## Why we chose what we chose

Nick's answers settled the transport and the scope. These are the decisions the spec left open, each with the alternative it beat:

- **The turn carries an `opensConversation` flag, set in the branch that picks the conversation.** The alternative was to infer "new" later from `#storedConversationId`. That field changes once the message is stored, so the check would have depended on where it sat relative to the append.
- **The mock treats a conversation ID it hasn't seen as empty, and answers with a fresh ID.** Before, it used whatever ID the request named. The real API never uses an ID that reads as empty (ADR-004), and the old behaviour would have let a page test pass with an ID the server would replace.
- **The mock's agent-failure `error` events name the conversation, on continued turns too.** The chat handler has done this since #104. Before this change the mock never did, so a Retry test against the mock couldn't tell a named failure from an unnamed one.
- **The mock records a first turn's conversation when its message is "stored", before the reply.** Before, it recorded the conversation only with `done`. Without the change, a Retry after a failed first turn would have read as a new conversation in the mock while it continues on the server.
- **The mock's `mid_stream` fault still ends in its `error` event, on every turn.** We read A-8's "a cut with a known ID" as: the fault's `error` now comes after the `conversation` line, so the ID is known before it fails. A-8 adds no new fault kinds, and `options.ts` defines `mid_stream` as ending in an `error` event; the page tests cover a stream cut with only the `conversation` line, through inline `server.use` overrides. The alternative was to end `mid_stream` with no terminal event on first turns only, which would give one fault two meanings. Nick chose this reading in review (e9af688/SPEC-3, option (a)).
- **One gap after the `conversation` event, `firstEventMs`, for the reply and for a fault alike.** A separate fault delay would add a knob that no test or UI state uses.
- **`ndjsonStream` gained an optional `afterFirstMs`.** It defaults to the old interval. The alternative was to sleep in the handler between two responses, but a response can't be split once it has started.
- **`loginSession.ts`'s header now says the session is also written from `conversation` and `error` events.** The file is outside the issue's owned paths. Its line had been incomplete since #104, and this change made it more so.

## What surprised us

- **`fetch` reads ahead, and a stream error throws away what it had buffered.** Our first page test for "the connection drops mid-read" enqueued the `conversation` line and then errored the body on the next pull. The page never saw the line, so Retry went out without an ID and the test failed for the wrong reason. A 50 ms delay before the error made it pass, which showed the cause. The committed test waits instead, with real I/O hops, until the page has written the login session from that line, and only then fails the read. A dropped connection in a browser has the same shape: whatever the reader had buffered but not yet handed over is lost, so the client only knows about lines it has already parsed.
- **Cutting the server's sink right after the first line didn't leave a half-finished reply.** The agent loop caught the failed `text_delta` write and ended the turn with `error` before any tool ran. So the resend took #104's re-run path (the stored message, then one reply), not the replay path. The server test now pins that.

## Evidence

- Server: `services/api/test/chat-turn.test.ts`, 57 tests. A new block (#160) records the order of a first turn's side effects: `append:user`, `open:200`, `write:conversation`, `model`. Other tests in it cover a replaced conversation, a continued one (no event), a failed first append (409, no event), and a client that goes away after the first line and then resends. The 429/503 tests became 200 for first turns, and a new test keeps 429/503 for continued turns.
- Client: the hook tests and the page tests resend with the named ID after a cut stream and after a mid-read network error, through the real `fetch` and `readChatStream`. A bare 502 or a network failure before any byte still resends without one.
- We broke the code it guards with `npm run mutate`, 30 exact edits, and every one turned a test red: 9 in the chat handler, 5 in the contract, 1 in the hook and 15 in the mock. The PR lists each edit and the tests it turned red.
- `npm run test:coverage` (DynamoDB Local running): 2351 passed in 100 files. `npm run coverage:changed`: every added source line ran.
- `dev` check, 2026-10-05, run by the orchestrating session. Nick ran its script locally, because it signs in a demo user.
  - **Deploy:** `scripts/deploy.sh api dev` from this branch at `a307a80` updated `sched-dev-api`, which had been at `bd775d6`. Only the api stack was deployed. The SPA wasn't, because it sends no token until #36.
  - **Method:** the script signed in the demo patient `maria.santos` and sent `POST /api/chat` through CloudFront with no `conversationId`. It disconnected at the first `text_delta` and waited for the turn's `chat turn` log line. Then it resent the same body with the named `conversationId` and called `POST /api/session`.
  - **Run 2, complete.** Headers arrived at 386 ms, and the first line was the `conversation` event at 387 ms. The first `text_delta` came at 1480 ms, 1093 ms later. So API Gateway and CloudFront did not buffer the small first line. The server log for the turn shows `completed`, 200, `done`, `messagesAppended` 4, `firstEventMs` 62, `firstTextMs` 1157 and `totalMs` 3451.
  - **The resend:** 200, `text_delta` then `done`, for the same conversation. Its log shows `retry: "answered"`, `replayed: true`, `messagesAppended` 0, no turn counted and `totalMs` 7. `POST /api/session` then showed the patient's message once, in 2 bubbles.
  - **Run 1:** the `conversation` line came at 1179 ms and the first `text_delta` at 2305 ms, a gap of 1126 ms. The script misread Lambda's JSON log format on this run and stopped before the resend.
  - **The disconnect:** in both runs the turn still finished as `completed` on the server after the client had gone. So on `dev` the resend took #104's replay path. The in-memory test, whose sink throws, takes the re-run path.
  - **Cost:** two Sonnet 4.6 first turns, a few cents. The resend made no model call.
  - **Not checked:** a resend while the original turn is still running, and the SPA in a browser, which needs #36.

## What's next

- Deploy `web` before `api`. A bundle built before v1.2 rejects the new line as unreadable.
- #38 measures time to first token with `firstTextMs`. `firstEventMs` now times the `conversation` event on new conversations.
- The `dev` check settled ADR-007's open question. API Gateway and CloudFront pass the small first line straight through: it arrived about 1.1 s before the first `text_delta` in both runs.
- Still to check: the page in a browser once #36 sends a token, and a resend while the original turn is still running (a non-goal here).
