# ADR-007: Chat transport — REST API with Lambda response streaming

- **Status:** Proposed. Pending spike S-2, which is part of the M1 walking skeleton.
- **Date:** 2026-09-28
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

## Decision (proposed)

**Option 3.**
- `POST /api/chat` is a **Regional REST API** method with a Cognito authorizer.
- It integrates with a Lambda wrapped in `awslambda.streamifyResponse` (Node.js 24).
- It streams **newline-delimited JSON events**. The event shapes are defined in `packages/contracts`:

```jsonc
{"type":"status","tool":"check_availability","label":"Checking Dr. Lee's availability…"}
{"type":"text_delta","text":"I found three openings"}
{"type":"done","messageId":"…","usage":{"inputTokens":…,"outputTokens":…,"cacheReadTokens":…}}
{"type":"error","code":"AGENT_UNAVAILABLE","message":"…","retryable":true}
```

- The **client typewriter** renders `text_delta` through a smoothing buffer: a constant characters-per-second pace, catching up on bursts. The text appears character by character whether the network delivers it in chunks or all at once, which satisfies FR-013. `prefers-reduced-motion` renders immediately.
- **CloudFront** routes `/api/*` to the REST API origin, so the site has one origin and no CORS. That behavior uses the managed `CachingDisabled` cache policy and `AllViewerExceptHostHeader` origin request policy, which forward the `Authorization` header.
- **Fallback:** if streaming through CloudFront or SAM proves unworkable in spike S-2, the same handler returns the event list as one buffered JSON array (option 2). The client already knows how to consume that shape.

## Consequences

- Tool-status chips and streaming text come from the same event stream, so the UI is honest about what the agent is doing.
- The API definition needs an OpenAPI body in SAM, because the `responseTransferMode` extension isn't a first-class SAM property.
- The handler must flush events promptly, and must always end the stream (`done` or `error`), even on exceptions.
- **Revisit if** we need server-initiated pushes (e.g., "your provider cancelled"). That would call for a WebSocket API.

## Validation (spike S-2, folded into issue M1-05)

- The deployed walking skeleton streams deltas through CloudFront → REST API → Lambda → Bedrock.
- Measure time to first byte (target ≤ 3 s at p50) and confirm the Cognito authorizer works with streaming.
