# 2026-10-02 — The mock API waits like the real one: no response headers until the first event

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #24, ADR-007, PRD FR-012, FR-016, NFR-005; unblocks #25, #26, #28

## What happened

The task-worker agent built the SPA shell in `apps/web`: Vite + React 19 + React Router 8, a layout with the demo disclaimer on every route, light and dark design tokens, and an MSW mock of `POST /api/session` and `POST /api/chat`. The mock exists so that the login, chat and voice streams can build their UI in parallel without waiting on the API.

The mock had to copy one detail of the real API. The S-2 spike (ADR-007) found that the Lambda writes its HTTP status and headers on its first write, so `fetch()` doesn't resolve until the model's first token, about 1 s. A mock that answers headers at once and then streams would let the chat UI hang its "processing" animation on the response and still look right. Against the real API, that UI would show nothing for a second. So the mock's chat handler waits `firstEventMs` (default 1000) before it returns the response, sends the first event with the headers, and then sends one event every `eventIntervalMs` (default 40, the spike's ~25 events/s).

## Why we chose what we chose

- **Error injection mirrors what the spike saw, not what was convenient.** A 401 is API Gateway's own `{"message":"Unauthorized"}`, not the contracts' `ApiError`, because the authorizer answers before any Lambda runs. A bad body is a 400 with one NDJSON `error` event, as measured. The 429/503 bodies (one retryable `error` event) and the mid-stream failure (200, part of the reply, then `error`) follow ADR-007's "the handler chooses the status late". #17 owns the real behaviour; if it differs, the mock changes with it.
- **The mock validates its own output.** Every event goes through `encodeStreamEvent` and the session body through `SessionResponse.parse`, and the session builds on `EXAMPLES.SessionResponse` from `@sched/contracts/testing`. A contract change breaks the mock's tests instead of letting the mock drift.
- **The mock never reaches production.** MSW 3's Vite plugin serves the worker script, and we apply it to the dev server only; `main.tsx` imports the mock behind `import.meta.env.DEV`. The production build has no MSW code and no `mockServiceWorker.js`, and `apps/web/build.test.ts` runs that build in `npm test` to keep it that way.
- **The disclaimer is persistent but not sticky.** The page body never scrolls; `<main>` does. So the header and disclaimer stay in view without `position: sticky`, which could cover a focused control when zoomed (WCAG 2.2, 2.4.11).

## What surprised us

- **Deep links will break in the deployed app.** The web stack deliberately has no CloudFront custom error responses (they would turn the API's 401s into `index.html`), and S3 behind OAC has no index-document fallback. So a refresh on `/chat` will get S3's 403, not the app. The dev server hides this. The fix belongs to `infra/stacks/web.yaml`: a CloudFront Function on the default behaviour only, as its own comment already suggests.
- **MSW 3 renamed the option every tutorial uses.** `onUnhandledRequest` is now `onUnhandledFrame`; the typecheck caught it.
- **Under Vitest, a Vite build ships the mock.** Vitest sets `NODE_ENV=test`, and Vite then builds with `import.meta.env.DEV` true, so the build test's first run found MSW in the bundle even though `npm run build` was clean. The test now pins `NODE_ENV=production` for the build.
- **Vitest blanks CSS imports, even `?raw` ones.** The contrast test read an empty string until the config opted `tokens.css` in. The test threw rather than passing vacuously, because it fails loudly when a token block is missing.

## Evidence

- Headless Chrome against the dev server (the MSW service worker, not Node): `POST /api/chat` headers at 1006 ms, then 20 events in 20 separate network chunks, the last at 1807 ms; `content-type: application/x-ndjson; charset=utf-8`; a mid-stream fault ended in `error:AGENT_UNAVAILABLE`.
- Tests in `apps/web`: 75. These deliberate breaks each made at least one test fail: removing the first-event wait or buffering the stream, an off-by-one message ID, a reset keeping 0 characters, a mid-stream fault ending in `done`, skipping body validation, dropping the disclaimer from the layout or changing its wording, putting the error boundary on the layout route, breaking the skip link or the focus move, a low-contrast muted text color, and a drift between the two dark-theme blocks. After the review of PR #95, also: removing each `latencyMs` wait (session, and the chat's network, 401, 400 and 429/503 paths) or the `eventIntervalMs` wait, streaming the whole reply before a mid-stream fault, moving a fault branch above body validation, dropping the abort check, breaking the `schedMock` merge, reset or corrupt-storage fallback, removing the `prefers-color-scheme` wrapper, hard-coding the clinic name, and, in the build, dropping `apply: "serve"`, removing the `import.meta.env.DEV` gate, moving the assets directory or adding a broken import. Tests not covered by a listed break (most contrast pairs, the token-key check, the `/` redirect, `parseMockApiOptions`, the 503 case, the session 500 and network cases) were not broken one by one.
- The build writes `apps/web/dist/index.html` plus `assets/`, the layout the walking skeleton's upload already used; `build.test.ts` checks it.

## What's next

- A CloudFront Function for SPA deep links on the web stack's default behaviour: #103, before #36 deploys the SPA.
- Uploading the built assets: the deploy workflow in #41.
- #25 deletes `src/skeleton/` (now one of its acceptance criteria).
- #26 builds the chat against this mock; #27 uses its error injection for retry and restore.
