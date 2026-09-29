# 2026-09-29 — The reply streams through CloudFront untouched: first token in about 1 s, 15 ms of overhead

**Chapter:** 3. The walking skeleton
**Milestone:** M1
**Related:** #7 (spike S-2), ADR-007 (now Accepted), ADR-002, ADR-003, ADR-005, PRD FR-013, NFR-001

## What happened

ADR-007 bet on a feature that was ten months old: API Gateway **REST** APIs gained Lambda response streaming in November 2025. The chat design depends on it. Tool-status chips and token-by-token text both need events to reach the browser while the agent is still working. Everything else in the stack had been done before. So #7 built the thinnest path through all of it:
- a Cognito-authenticated `POST /api/chat`;
- CloudFront → a Regional REST API with `responseTransferMode: STREAM` → a `streamifyResponse` Lambda → Claude Sonnet 4.6 on Bedrock;
- a bare page that signs in and prints the NDJSON `text_delta` events as they land.

The agent (Claude) wrote the stacks, handler, page, and measurement script. Both stacks deployed on the first attempt. The first `curl -N` through CloudFront printed 43 events, one line at a time, over 1.6 seconds. We then ran 10 paced requests through CloudFront and 10 directly against execute-api. Every one ended in `done`, arriving in 60–81 separate network chunks.

## Why we chose what we chose

- **We called Bedrock directly, for now.** `LlmClient` was being built in parallel (#15). To avoid waiting, or inventing a second interface, the handler calls `AnthropicBedrock` directly. The file is marked temporary, and #17 swaps in the agent loop. The part worth keeping is the streaming shell. It chooses the HTTP status lazily, it always ends with `done` or `error`, and it takes identity only from the authorizer's claims.
- **We bundle with a Makefile, not SAM's esbuild builder.** SAM's esbuild workflow copies the function's folder to a scratch directory and runs `npm install` there. Our workspace packages (`@sched/contracts`) aren't on npm, so that install can't work. A small Makefile runs esbuild from the repo root instead, via SAM's `Metadata.WorkingDirectory`. It resolves workspaces exactly as the tests do, and `scripts/deploy.sh` needed no change. We read SAM CLI's source to confirm one detail: for Node.js runtimes, `--cached` still reruns make on every build. A change in `packages/*` therefore can't ship a stale bundle.
- **Other stacks' values are read with SSM dynamic references, not typed parameters.** A typed parameter's default can't depend on `Env`. So `scripts/deploy.sh all pr52` would silently wire an ephemeral API to *dev's* user pool. `!Sub '{{resolve:ssm:/sched/${Env}/…}}'` can't make that mistake.

## What surprised us

- **Nothing buffered.** We expected CloudFront to be the problem hop. At p50 it added about **15 ms** over going direct: 1.03 s vs 1.04 s to first token, 161 ms vs 145 ms of transport overhead. The 1.6–2 s pauses mid-stream appeared on both paths, so they come from the model. About 85% of time-to-first-token is Bedrock.
- **The first byte *is* the first token.** The Lambda runtime holds the HTTP status line and headers until the handler's first write. For the UI this means "processing" must start on send, not on headers. It also turned out useful: bad input still gets a real 400, and an up-front Bedrock throttle gets a 429, because no status has gone out yet.
- **The next endpoint is already in trouble.** While checking header forwarding, we found that CloudFront strips `Authorization` from GET and HEAD requests unless the header is in the cache key. The `CachingDisabled` policy can't have one. `POST /api/chat` is fine; a `GET /api/session` would arrive without its token. That's a note for #18, found before it cost a day.
- **A one-line CSS trap.** Headless Chrome caught the page's login form refusing to hide: `form { display: grid }` beats the browser's own `[hidden]` rule.

## Evidence

| N=10 each, warm, laptop → edge ATL59 | Via CloudFront p50 / p95 | Direct p50 / p95 |
|---|---|---|
| Time to first byte (= first `text_delta`) | 1.03 s / 2.66 s | 1.04 s / 1.80 s |
| Total | 3.90 s / 7.07 s | 4.07 s / 5.87 s |
| Lambda's own first delta | 0.86 s / 2.44 s | 0.85 s / 1.64 s |
| Network chunks per response (median) | 73 | 71 |

- Sonnet 4.6, no thinking, about 97 input and 149 output tokens per reply. 20/20 runs ended with `done`.
- Cold start: 474 ms init; first delta at 1.85 s via CloudFront (`curl -N`).
- Auth checks:
  - No token or a malformed token → 401 on both paths.
  - Bad body with a valid token → 400 plus an NDJSON `error` event, passed through CloudFront unchanged.
- Raw data and summaries: `spikes/s2-streaming/results/` (`summary-2026-09-29T12-57-54-884Z.md`, `notes-2026-09-29.md`).
- ADR-007 flipped to **Accepted**. The buffered-array fallback stays in the contracts, unused.

## What's next

- #17 replaces the direct Bedrock call with `runAgentTurn` + `LlmClient`, and measures turns with tool calls and adaptive thinking against the same 3 s target.
- #18 decides how `GET /api/session` gets its token through CloudFront. The options are in ADR-007.
- #24 replaces the skeleton page with the real SPA, including the typewriter smoothing in FR-013.
