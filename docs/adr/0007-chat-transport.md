# ADR-007: Chat transport — REST API with Lambda response streaming

- **Status:** Accepted (2026-09-29). Spike S-2, run as part of the M1 walking skeleton (#7), confirmed it; see Validation.
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
  - 429/503 when Bedrock rejects the call up front;
  - 200 once text flows, with a mid-stream failure becoming an `error` event under 200.

  The UI must start its "processing" animation on send, not on response headers.
- **CloudFront drops `Authorization` on GET and HEAD.** It forwards the header only for POST/PUT/PATCH/DELETE (and uncached OPTIONS). The `/api/*` behavior uses `CachingDisabled`, so it can't put the header in a cache key. Our `POST /api/chat` is unaffected, but a `GET /api/session` (#18) would reach the authorizer without its token and get 401. #18 must pick one of these:
  - a custom cache policy whose cache key includes `Authorization`, with the origin sending `Cache-Control: no-store`;
  - a POST for the session call;
  - a different identity-source header for the authorizer.
- **SAM's `BuildMethod: esbuild` doesn't work with our npm workspaces.** It runs `npm install` in an isolated copy of `CodeUri`, where `@sched/contracts` can't resolve. Functions use `BuildMethod: makefile` with `Metadata.WorkingDirectory` at the repo root, and `services/api/Makefile` runs esbuild there. With `nodejs*` runtimes, `sam build --cached` still reruns make on every build, so edits in `packages/*` can't leave a stale bundle. This refines ADR-003's bundling line.
