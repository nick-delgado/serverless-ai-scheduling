# ADR-007: Chat transport — REST API with Lambda response streaming

- **Status:** Accepted (2026-09-29). Spike S-2, run as part of the M1 walking skeleton (#7), confirmed it; see Validation.
- **Amended:** 2026-10-03 (the session call is `POST /api/session`; see [Amendment](#amendment-2026-10-03-the-session-call-is-a-post-18)); 2026-10-03 (what the chat handler settled, #17; see [Amendment](#amendment-2026-10-03-what-the-chat-handler-settled-123)); 2026-10-04 (chat retries as built, #104; see [Amendment](#amendment-2026-10-04-chat-retries-as-built-104)); 2026-10-05 (Retry after a 5xx without an event or a cut stream, #138; see [Amendment](#amendment-2026-10-05-retry-after-a-5xx-without-an-event-or-a-cut-stream-138)); 2026-10-05 (name a new conversation before the agent runs, #160; see [Amendment](#amendment-2026-10-05-name-a-new-conversation-before-the-agent-runs-160))
- **Date:** 2026-09-28 (proposed), 2026-09-29 (accepted)
- **Deciders:** Nick Delgado (+ Claude, drafting)
- **Related:** PRD FR-012, FR-013, NFR-001, ADR-001, ADR-003

## Context

An agent turn may involve several model calls and tool calls. With adaptive thinking, a complex turn can take 10–30 s. The UX calls for:
- a "processing" animation;
- tool-status feedback (our addition: *"Checking Dr. Lee's availability…"*);
- agent text that appears **a character at a time**.

The original sketch used an API Gateway **HTTP API**, which has a **hard 30 s integration timeout** and no response streaming. In November 2025, API Gateway **REST APIs gained response streaming**:
- up to a 15-minute integration timeout;
- a 5-minute idle timeout on Regional endpoints;
- Cognito authorizers supported;
- Lambda integrations via `.../response-streaming-invocations` with `responseTransferMode: STREAM`.

The limitations don't affect us: no VTL response transforms, no integration caching, no content encoding.

## Options considered

1. **HTTP API, buffered JSON.** Simple, but the 30 s cap is a real risk for multi-tool turns, and tool status can only arrive at the end.
2. **REST API, buffered, with the timeout raised beyond 29 s.** Removes the timeout risk, but there's still no live progress.
3. **REST API + Lambda response streaming (NDJSON events).** Live tool status, real token streaming, a long timeout, and it fits CloudFormation/SAM (OpenAPI definition).
4. **WebSocket API.** Fully bidirectional, but it needs a connections table, `@connections` posting, and reconnect logic. Too much for request/response chat.

## Decision

**Option 3.**
- `POST /api/chat` is a **Regional REST API** method with a Cognito authorizer.
- It integrates with a Lambda wrapped in `awslambda.streamifyResponse` (Node.js 24).
- It streams **newline-delimited JSON events**. The event shapes are defined in `packages/contracts`:

```jsonc
{"type":"status","tool":"check_availability","label":"Checking Dr. Lee's availability…"}
{"type":"text_delta","text":"I found three openings"}
{"type":"text_reset","keepChars":0}
{"type":"done","messageId":"…","usage":{"inputTokens":…,"outputTokens":…,"cacheReadTokens":…}}
{"type":"error","code":"AGENT_UNAVAILABLE","message":"…","retryable":true}
```

*(Refined by the [2026-10-03 amendment](#amendment-2026-10-03-what-the-chat-handler-settled-123): `done` carries `conversationId`.)* *(Refined by the [#160 amendment](#amendment-2026-10-05-name-a-new-conversation-before-the-agent-runs-160): a first `conversation` event names a new conversation.)*

- The **client typewriter** renders `text_delta` through a smoothing buffer: a constant characters-per-second pace, catching up on bursts. The text appears character by character whether the network delivers it in chunks or all at once, which satisfies FR-013. `prefers-reduced-motion` renders immediately.
- **`text_reset`** (contracts v1.1, #60). When the agent loop throws away a response whose text already streamed (a refusal, a `max_tokens` cut-off, or malformed output) and retries, it sends `{"type":"text_reset","keepChars":N}`. The client truncates the in-progress assistant bubble to its first `N` characters (JavaScript string length over this turn's `text_delta`s), drops anything beyond that still queued in the typewriter buffer, and keeps rendering the deltas that follow. Applying every reset in order yields exactly the text the turn stored; `visibleText()` in `packages/contracts` is the reference implementation. A reset never follows `done` or `error`.
- **CloudFront** routes `/api/*` to the REST API origin, so the site has one origin and no CORS. That behavior uses the managed `CachingDisabled` cache policy and `AllViewerExceptHostHeader` origin request policy, which forward the `Authorization` header.
- **Fallback:** if streaming through CloudFront or SAM proves unworkable in spike S-2, the same handler returns the event list as one buffered JSON array (option 2). The client already knows how to consume that shape.

## Consequences

- Tool-status chips and streaming text come from the same event stream, so the UI is honest about what the agent is doing.
- The API definition needs an OpenAPI body in SAM, because the `responseTransferMode` extension isn't a first-class SAM property.
- The handler must flush events promptly, and must always end the stream (`done` or `error`), even on exceptions.
- **Revisit if** we need server-initiated pushes (e.g., "your provider cancelled"). That would call for a WebSocket API.

## Validation (spike S-2, folded into issue M1-05)

The plan was:
- The deployed walking skeleton streams deltas through CloudFront → REST API → Lambda → Bedrock.
- Measure time to first byte (target ≤ 3 s at p50) and confirm the Cognito authorizer works with streaming.

### Results (2026-09-29, #7)

**Setup.** `sched-dev`, deployed from `spike/7-walking-skeleton`:
- CloudFront (`/api/*` behavior: `CachingDisabled` + `AllViewerExceptHostHeader`, origin path = stage).
- Regional REST API, Cognito User Pool authorizer, `responseTransferMode: STREAM`, `timeoutInMillis` 300000.
- Lambda `nodejs24.x` / arm64 / 1024 MB with `awslambda.streamifyResponse`.
- Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`, no thinking). About 97 input and 149 output tokens per reply.

The client was a laptop in the US Southeast (edge POP ATL59). `spikes/s2-streaming/measure.ts` ran 10 requests per target, round-robin, 8 s apart. Raw data: `spikes/s2-streaming/results/`.

| Metric (N=10 each, warm) | Via CloudFront p50 / p95 | Direct execute-api p50 / p95 |
|---|---|---|
| Time to first byte (= response headers) | **1.03 s** / 2.66 s | 1.04 s / 1.80 s |
| Time to first `text_delta` | **1.03 s** / 2.66 s | 1.04 s / 1.80 s |
| Total (stream ended) | 3.90 s / 7.07 s | 4.07 s / 5.87 s |
| Lambda's own first delta (from its log) | 0.86 s / 2.44 s | 0.85 s / 1.64 s |
| Transport overhead, first delta (client − Lambda) | 161 ms / 224 ms | 145 ms / 228 ms |
| Network chunks per response (median) | 73 | 71 |

p95 is nearest-rank, so with N=10 it is the maximum. 20/20 runs ended with `done`.

**What the numbers say:**
- **Streaming is truly incremental through CloudFront.** Every response arrived in 60–81 separate network chunks, almost always one NDJSON event per chunk (only 9 of 1,428 chunks carried two). The chunks were spread over 1–4.6 s, at about 25 events/s: the model's own pace.
- **No buffering or compression.** The mid-stream pauses of 1.6–2.0 s show up on both paths, so they come from Bedrock, not CloudFront. No response had `content-encoding`, and every one said `x-cache: Miss from cloudfront`.
- **CloudFront adds about 15 ms at p50** over the direct execute-api URL. The model dominates: about 85% of time-to-first-token is Bedrock.
- **Cold start.** Init was 474 ms. The first request after deploy (`curl -N`) saw its first delta at 1.85 s, still within target.
- **NFR-001 / the ADR target is met.** Time to first byte is 1.03 s p50 against a 3 s target, and full turns take about 4 s. Numbers for agent turns with tools come with #17.
- **Auth.**
  - With no token or a malformed token, API Gateway returns 401 `{"message":"Unauthorized"}` on both paths.
  - With a valid ID token the authorizer passes and the stream flows, so the Cognito authorizer and streaming work together.
  - A bad body with a valid token gets 400 plus one NDJSON `error` event, and CloudFront passes it through unchanged (no custom error responses).
- **The browser renders progressively.** Checked with headless Chrome on the skeleton page, over HTTP/2.

**Decision:** accepted as proposed. The buffered-array fallback isn't needed. `parseChatResponseBody` keeps supporting it anyway, at no cost.

### Learned during the spike (consequences for later work)

- **Headers arrive with the first event.** The Node.js runtime writes the HTTP status/header prelude on the first `write()`, so a client sees nothing until the model's first token. That makes TTFB equal to time-to-first-token. It also lets the handler choose the status late:
  - 400 for bad input;
  - 429/503 when Bedrock rejects the call up front; *(Refined by the [#160 amendment](#amendment-2026-10-05-name-a-new-conversation-before-the-agent-runs-160): only in a continued conversation.)*
  - 200 once text flows, with a mid-stream failure becoming an `error` event under 200.

  The UI must start its "processing" animation on send, not on response headers.
- **CloudFront drops `Authorization` on GET and HEAD.** It forwards the header only for POST/PUT/PATCH/DELETE (and uncached OPTIONS). The `/api/*` behavior uses `CachingDisabled`, so it can't put the header in a cache key. Our `POST /api/chat` is unaffected, but a `GET /api/session` (#18) would reach the authorizer without its token and get 401. #18 must pick one of these:
  - a custom cache policy whose cache key includes `Authorization`, with the origin sending `Cache-Control: no-store`;
  - a POST for the session call;
  - a different identity-source header for the authorizer.

  *(Settled by the [amendment](#amendment-2026-10-03-the-session-call-is-a-post-18): a POST.)*
- **SAM's `BuildMethod: esbuild` doesn't work with our npm workspaces.** It runs `npm install` in an isolated copy of `CodeUri`, where `@sched/contracts` can't resolve. Functions use `BuildMethod: makefile` with `Metadata.WorkingDirectory` at the repo root, and `services/api/Makefile` runs esbuild there. With `nodejs*` runtimes, `sam build --cached` still reruns make on every build, so edits in `packages/*` can't leave a stale bundle. This refines ADR-003's bundling line.

## Amendment (2026-10-03): the session call is a POST (#18)

Nick picked the second option on 2026-09-29: the session call is **`POST /api/session`** with an empty or `{}` body, behind the same Cognito authorizer as `POST /api/chat`.

- **Why:** CloudFront forwards `Authorization` for POST under our `CachingDisabled` `/api/*` behavior, so no custom cache policy or extra header is needed, and a POST is never cached. Both API calls now look the same to CloudFront and the authorizer.
- **Shape:** a buffered JSON `SessionResponse` from its own read-only Lambda (`sched-<env>-api-session`), not a stream. Any other body is a 400 `ApiError`; the patient still comes only from `claims.sub` (ADR-005). The response carries `Cache-Control: no-store`.
- **Consequences:** `GET /api/session` doesn't exist (API Gateway answers it with 403 before any Lambda runs). The SPA's mock already uses POST (#24). The stage-wide throttle (5 req/s, burst 10) now covers session calls as well as chat turns.

## Amendment (2026-10-03): what the chat handler settled (#123)

The decision stands. Building the chat handler (#17, PR #96) settled these transport details:

- **`done` carries `conversationId`.** An unknown or foreign `conversationId` in the request starts a new conversation with a server-generated ID, never an error (not-yours and doesn't-exist look the same, ADR-004); `done` tells the client which ID it got.
- **Status before streaming:** 400 `BAD_REQUEST`; 401 `UNAUTHORIZED`; 429 `RATE_LIMITED` for Bedrock throttling (retryable) and for the daily turn cap (not retryable, ADR-009); 409 `AGENT_UNAVAILABLE` (retryable) when another turn of the conversation wrote first; 503 `AGENT_UNAVAILABLE` for other agent errors; 500 `INTERNAL`. *(Refined by the [#160 amendment](#amendment-2026-10-05-name-a-new-conversation-before-the-agent-runs-160): a turn that starts a conversation answers agent errors with 200 and an `error` event.)*
- **Timeout:** the chat Lambda has 180 s and aborts the loop 15 s earlier, so it can store the turn and end the stream with `error`.
- **Alternation:** a turn that fails after the patient's message is stored is closed with a fixed assistant reply, because Converse requires alternating roles; history stays append-only. *(Refined by the [2026-10-04 amendment](#amendment-2026-10-04-chat-retries-as-built-104): closed at once only after a tool ran.)*
- **Retries** (planned, #27 and #104, decided on #123): the client offers Retry only for a retryable error or a network failure, and resends the same text with the same `clientMessageId` and `conversationId`. The server answers a repeat of an already-answered message by streaming the stored reply's visible text again as `text_delta` and ending with `done` carrying the stored `messageId`, with no model call and no counted turn. *(Built by the [2026-10-04 amendment](#amendment-2026-10-04-chat-retries-as-built-104); the client's rule is widened by the [2026-10-05 amendment](#amendment-2026-10-05-retry-after-a-5xx-without-an-event-or-a-cut-stream-138).)*

## Amendment (2026-10-04): chat retries as built (#104)

The decision stands. Building retries (#104, FR-015) settled:

- **What a repeat is.** The patient's stored message carries the `clientMessageId` it was sent with (an optional field on `ConversationMessage`, written in the same append). A send is a repeat only when its ID is the one on the **last** patient message of the loaded, owned conversation; anything else is a new message. The same ID with different text is a 400 `BAD_REQUEST`, and nothing is stored or counted.
- **Alternation.** A turn that fails **before any tool ran** is no longer closed: it ends at the patient's message. A new message closes it with the fixed reply first, in the same append, as before. A turn that fails **after** a tool ran is closed at once, as before.
- **A repeat of an answered message** (including one closed after a tool ran) streams the assistant bubble that restore shows for that turn as one `text_delta`, then `done` with that bubble's `messageId` and zero usage. No `status` events, no model call, no counted turn, no trace. It is served even at the daily cap. A turn whose storing stopped after a tool result (a crash between batches) gets the fixed reply first, then replays it.
- **A repeat of an interrupted message** (it has no reply) runs the agent on the history before it, with a new `turnId`, and doesn't store the patient's message again or count a turn. A repeat that arrives while the original is still running is treated the same way; whichever turn stores second gets the retryable 409.
- **`error` carries `conversationId`** (optional) whenever the conversation exists in storage when the error is sent: this request stored the patient's message, or it continued a stored conversation. It is omitted for 400, 401, the daily cap, and a failed first append of a new conversation. The client sets it as it does from `done`, so Retry after a failed first turn, and a reload, continue that conversation (FR-014).

## Amendment (2026-10-05): Retry after a 5xx without an event or a cut stream (#138)

The decision stands. With #104 de-duplicating a resend by `clientMessageId`, the client's Retry rule (the 2026-10-03 amendment's **Retries** bullet) is widened:

- **Retry is offered** for a stream `error` event with `retryable: true` (unchanged), a network failure (unchanged), an HTTP 5xx whose body is not an `error` event (API Gateway's or CloudFront's own 5xx), and a stream that ends cleanly without `done` or `error`, including an empty 200 body. The client marks the last case with `ChatStreamEndedError`, a subclass of `ChatProtocolError`.
- **No Retry** for a 4xx without an event (a 401 still signs the patient out; API Gateway's throttle 429 is included), a malformed or unreadable event (including a final line cut mid-way), or an unreadable buffered array. A buffered body is read whole, so one without `done` or `error` counts as unreadable, not cut.
- **The asymmetry at 500.** A bare 500 offers Retry, while the handler's own 500 `INTERNAL` arrives as an `error` event with `retryable: false` and doesn't: the event's flag decides whenever there is an event.
- **What a resend is safe from.** With the same `conversationId`, a resend replays the stored reply or stores the turn once (the 2026-10-04 amendment). Two cases stay open. A failed first turn whose failure named no conversation resends without a `conversationId`, so the server stores the message again in a new conversation and counts a second turn, as a first-turn network failure already does (#160 tracks naming the conversation before the agent runs). And a resend that arrives while the original turn is still running is accepted: both run, and whichever stores second gets the retryable 409. That is likelier after a CloudFront 504 (60 s origin read timeout) than after an `error` event, because the Lambda has 180 s. *(Refined by the [#160 amendment](#amendment-2026-10-05-name-a-new-conversation-before-the-agent-runs-160): the first case narrows to a failure before the `conversation` event arrives.)*

## Amendment (2026-10-05): name a new conversation before the agent runs (#160)

The decision stands. A first turn's Retry used to start a second conversation whenever the failure named none (the 2026-10-05 amendment's "What a resend is safe from"). The server now names the conversation before the agent runs:

- **A `conversation` event** (contracts v1.2): `{"type":"conversation","conversationId":"…"}`. It is not terminal. The chat handler writes it as the first event, as soon as the patient's message is stored and before the model's first request, on every turn that **starts** a conversation: no `conversationId` in the request, or one that read as empty (unknown, expired or another patient's). A turn that continues a stored conversation doesn't send it, and neither does a request refused before the message is stored (400, 401, the daily cap, a failed first append), a replay or a re-run. The client remembers the ID as it does from `done`: for the next send and in the login session, for a reload (FR-014).
- **Why an event and not a response header.** Only an event can go out before the model's first token: the runtime sends headers with the first write, so a header would wait for the first `status`, `text_delta` or `error`, and a crash before then would still end as a gateway 5xx with no ID. An event also needs no change to the Lambda wrapper, and no check that API Gateway and CloudFront pass a custom header through.
- **Statuses.** On a turn that starts a conversation, the response is 200 from the `conversation` event on, so a Bedrock throttle or another agent error there arrives as 200 plus an `error` event with the same code and `retryable` flag, as a mid-stream failure already did. A turn that continues a stored conversation keeps the 2026-10-03 amendment's 429/503/409 statuses. The client reads the event either way, so the patient sees no difference.
- **What a resend is safe from, now.** Once the `conversation` line has reached the client, a cut stream or a connection dropped mid-read resends with that `conversationId`, and the server replays or re-runs the turn (the 2026-10-04 amendment) without storing the message twice or counting a turn. Once the message is stored the response is already 200, so a later Lambda crash reaches the client as a cut stream, not a bare 5xx. One first-turn case stays open: a failure **before** the ID arrives (a network failure before any byte, or API Gateway's or CloudFront's own 5xx, which carries no Lambda bytes) still resends without one and stores the message again in a new conversation. The other open case (a resend while the original is still running) is unchanged.
- **Deploy order.** An SPA bundle built before contracts v1.2 reads the new line as an unreadable event and shows the generic error without Retry. So this change deploys `web` before `api` (`scripts/deploy.sh all` runs `api` first), and a tab left open from before the deploy fails its first turns until it reloads.
- **Measuring.** The turn log's `firstEventMs` now times the `conversation` event on these turns; `firstTextMs` stays the time to first token (NFR-001). On `dev` (2026-10-05), API Gateway and CloudFront delivered the first line at once: 387 ms after the request, about 1.1 s before the first `text_delta`. A Lambda turn whose client disconnected still completed, so a resend after it replayed the stored reply.
