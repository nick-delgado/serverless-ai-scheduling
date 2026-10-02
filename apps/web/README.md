# @sched/web

The patient-facing SPA: React 19 + React Router 8, built by Vite into static assets for the web stack (`infra/stacks/web.yaml`).

```bash
npm run dev -w apps/web          # dev server with the MSW mock API
npm run build -w apps/web        # → apps/web/dist/ (index.html + assets/)
npm test -w apps/web             # Vitest + Testing Library (jsdom), MSW in Node
```

## Layout

| Path | What | Owner |
|---|---|---|
| `src/app/` | Routes, layout, disclaimer banner, error and not-found pages | S5-01 (#24) |
| `src/styles/` | Design tokens (light/dark) and base styles | S5-01 (#24) |
| `src/mocks/` | MSW mock API: handlers, fixtures, options | S5-01 (#24) |
| `src/pages/Login*`, `src/auth/` | Login and auth state | S1-02 (#25) |
| `src/chat/` | Chat page, stream client, typewriter | S5-02 (#26), S5-03 (#27) |
| `src/voice/` | Voice overlay and transcriber | S6-01 (#28) |
| `src/skeleton/` | The walking-skeleton page (#7), with its own build; see its README | removed with #25 |

## The mock API

`src/mocks` stands in for `POST /api/session` and `POST /api/chat`. Its responses are validated against `@sched/contracts`, and the chat stream keeps the real API's timing: no response headers until the first event (`firstEventMs`, default 1 s), so start a "processing" state on send, not on the response (ADR-007).

- **Dev server:** on by default. `VITE_MOCK_API=off npm run dev -w apps/web` turns it off. In the browser console, `schedMock.set({ chatFault: "mid_stream" })` changes the options (kept in local storage), `schedMock.options()` shows them, and `schedMock.reset()` restores the defaults.
- **Tests:** `src/test/setup.ts` installs it for every test, with no delays and no faults. `configureMockApi({ ... })` from `src/mocks/node` changes options for one test; they reset after each test. `server.use(...)` from the same module overrides a handler.
- **Options** (`src/mocks/options.ts`): `latencyMs`, `firstEventMs`, `eventIntervalMs`; `chatReply` (`tools`, `plain`, `reset`); `chatFault` (`network`, `unauthorized`, `rate_limited`, `unavailable`, `mid_stream`); `session` (`upcoming`, `no_upcoming`, `restore`); `sessionFault` (`network`, `unauthorized`, `internal`).

Production builds contain no mock code: the worker script is served by the dev server only, and `main.tsx` loads the mock behind `import.meta.env.DEV`.

## Conventions

- Colors come from the tokens in `src/styles/tokens.css`; `tokens.test.ts` checks every text/background pair against WCAG AA in both themes. Add a pair there when you add a token.
- Pages render their own `<title>` with `pageTitle()`.
- `<main>` scrolls, not the document, so the header and disclaimer stay in view. A page that needs a pinned composer can fill `<main>` with a flex column.
