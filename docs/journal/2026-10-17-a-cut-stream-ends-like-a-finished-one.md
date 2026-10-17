# 2026-10-17 — A cut Bedrock stream ends exactly like a finished one, so the client now checks for the last two events

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #316, PR #317, PR #315, ADR-008, ADR-010, ADR-007, PRD FR-041

## What happened

PR #315's Eval gate run [38996477524](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38996477524) (attempt 1) failed with "4 case(s) below the baseline (at most 1)": `l1-availability-after-dst`, `l1-availability-specialty-next-week`, `l1-book-after-explicit-yes` and `l1-escalate-explicit-request`. The same four had passed on the PR's previous gate run, and the fix round between them touched neither the prompt nor the tools. The L1 step logged 14 retries on `ServiceUnavailableException`, so Nick filed #316 on the guess that a call ran out of retries and came back empty.

The readiness review (the `review-agent-issue` skill, round 1) found a different path. No call ran out of retries: 23 calls for 9 cases, at most 5 retries on one call, and two of the failed cases had none. An exhausted retry already ends a trial `error`. What the six $0 trials in the results file had in common was all-zero usage and stop reason `end_turn`: the four that failed, plus two that passed on cut text (`l1-emergency-911`'s "Please call 911 right now." and `l1-vague-request-clarify`'s "I'd be happy to help you book an appointment," with a trailing comma). `l1-book-after-explicit-yes` "called" `book_appointment` with input `{}`, which is what `ResponseAssembler.finish()` makes of a tool block that started and never got its input. `ConverseLlmClient.streamMessage` returned `finish()` whenever the iterator ended, so a stream that stopped early came back as a complete `end_turn` reply with zero usage, and the grader graded it.

Nick settled four questions on #316 (r1/Q-1 to Q-4, all as recommended). The agent then built it:

- `ConverseLlmClient.streamMessage` rejects with `IncompleteStreamError` when the stream ends without a `messageStop` event or without a `metadata` event carrying `usage`. The message names what's missing (`ConverseStream ended without messageStop, metadata`), and the error carries the list as `missing`. A turn the signal aborted keeps its abort error, because the client calls `throwIfAborted()` again after the loop, before the check.
- The evals rate limiter lists `IncompleteStreamError` as transient, so a cut call retries like a 5xx (ADR-008's [2026-10-17 amendment](../adr/0008-evaluation-strategy.md#amendment-2026-10-17-a-cut-converse-stream-is-retried-then-an-error-316)). A trial ends `error` only when every attempt is cut, and the gate's one re-run of errored cases then applies.
- Production chat changes too, with no edit under `services/api`: a cut chat turn now ends `outcome: "error"`, which the chat handler maps to AGENT_UNAVAILABLE with Retry, instead of being stored as a completed partial reply that could hold a `tool_use` with no `tool_result`. The loop never appends the cut reply, so append-only history stays valid.

The tests replay the run's three cut shapes as `ConverseStream` event lists (no events; one text delta; a `book_appointment` tool start), plus each missing event alone, and two complete counter-cases (`end_turn`, and `max_tokens`, which stays the agent's failure). In `packages/evals/test/l1.test.ts`, `l1-book-after-explicit-yes` runs through the real `ConverseLlmClient` and `rateLimited` over a fake sender and a virtual clock: cut on every attempt it ends `error` with the error's name and the missing events in `reason`, and cut once then complete it passes.

## Why we chose what we chose

The four owner decisions are on #316 (readiness r1). The rejected alternatives were a check in the evals only (`runL1Trial` and the runner reading `providerStopReason === "unknown"` or zero usage, Q-1 (b)), or in the rate-limit wrapper (Q-1 (c)). Either one would have left the simulator, the judge or chat resolving cut replies. On the rule, "no `messageStop`" alone (Q-2 (a)) can't be shown to cover the five trials without a tool call. Not retrying (Q-3 (b)) would have left the gate's single re-run as the only second chance.

Decisions the spec left open, made by the agent:

- **What "messageStop arrived" means.** The assembler keeps its own `#sawStop` flag rather than testing the raw stop reason for `undefined`, so a `messageStop` whose `stopReason` is missing still counts as arrived (it maps to `end_turn` as before). The alternative would have retried a stream Bedrock had finished. `metadata` counts only with `usage`, as Q-2 (b) words it.
- **The order of the checks.** `messageStop` is listed before `metadata`, the order Bedrock sends them, and both are listed when both are missing (A-3's example), rather than naming only the first.
- **The name string is written twice.** `packages/evals/src/rate-limit.ts` lists `"IncompleteStreamError"` as a string, with a comment pointing at the class, instead of importing the class. Exporting it from `@sched/agent` would touch `packages/agent/src/index.ts`, outside the issue's owned paths, and `isRetryable` reads names anyway. The L1 test fails if the two drift (the PR's mutate table, rows `error-name` and `not-retried`).
- **`providerStopReason ?? "unknown"` stays.** `streamMessage` can no longer reach it, but `ResponseAssembler.finish()` is exported and can still be called without a `messageStop`, so the fallback stays with a comment saying so (r1/Q-1's "remove it or comment why it stays").
- **The existing converse tests gained one shared `someUsage` event** rather than ten differently-sized ones, since none of them asserts usage.

## What surprised us

The SDK can't tell a cut stream from a finished one, and the readiness review couldn't check that (A-9). The agent read the installed code and then cut streams on purpose:

- **The framing has no end marker.** `getChunkedStream` in `@smithy/core`'s event-streams submodule (3.35.0, the copy `@aws-sdk/client-bedrock-runtime` 3.1143.0 loads) splits the body into frames. When the body ends it throws `Truncated event message received.` only if a frame is half read; at a frame boundary it just returns. Whether a reply is complete is only known from its last events, `messageStop` and `metadata`.
- **Bedrock's client talks HTTP/2, and the handler drops errors after the headers.** The client is built with `NodeHttp2Handler`. Its `aborted`, `error` and `frameError` listeners call `rejectWithDestroy`, which rejects the request's promise. Once the response headers have arrived, that promise has already resolved, so the reject does nothing, and nothing in the handler passes the error on to the body stream.
- **Every cut we tried ended cleanly.** A local h2c server sent one `contentBlockDelta` frame, then cut the stream, and the real `BedrockRuntimeClient` read it. Five ways of cutting (END_STREAM, RST_STREAM with `NO_ERROR`, RST_STREAM with `INTERNAL_ERROR`, GOAWAY plus session destroy, and a destroyed socket) all gave one event and then a clean end of the iterator, on Node 26.9.0 and Node 24.22.0 (the Lambda runtime's major). Only half a frame threw. Read with plain `node:http2`, without the SDK, the `INTERNAL_ERROR` reset and the destroyed socket also ended the loop cleanly, so part of this is Node's own behaviour, not the SDK's alone.

So we know how a cut stream reaches us as a clean end, but not what cut run 38996477524's streams: Bedrock, something on the network path, or the connection. The client can't see that, and the fix doesn't depend on it.

## Evidence

- Gate run [38996477524](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38996477524), attempt 1, at `56c9384`: the L1 log's "23 calls, 14 retries, 0 throttled" and six `$0.00000` trials (figures from #316's description, checked in readiness r1).
- Code read: `node_modules/@smithy/core/dist-cjs/submodules/event-streams/index.js` (`getChunkedStream`), `node_modules/@smithy/node-http-handler/dist-cjs/index.js` 4.12.1 (`NodeHttp2Handler`, `rejectWithDestroy`), and `node_modules/@aws-sdk/client-bedrock-runtime/dist-cjs/index.js` (`requestHandler: NodeHttp2Handler.create(…)`).
- The cut-stream probe was a throwaway script outside the repository, using synthetic credentials against `127.0.0.1`, with no AWS call. It is evidence for the PR, not a test.
- Tests: `packages/agent/test/converse.test.ts` ("ConverseLlmClient rejects a stream that ends incomplete (#316)") and `packages/evals/test/l1.test.ts` ("a cut Converse stream is an error trial, retried first (#316)"), each seen failing in the PR's mutate table.

## What's next

- The PR's own Eval gate is the first live run with the check. A cut call there shows up as a retry in the log, not as a $0 trial.
- #247 guards the tool name in the same `finish()` branch and fights the same symptom class, a stored `tool_use` that breaks later requests.
