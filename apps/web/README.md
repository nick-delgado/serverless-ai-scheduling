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
| `src/pages/Login*`, `src/auth/` | Login, auth state, the `/chat` guard, sign-out | S1-02 (#25) |
| `src/chat/` | Chat page, stream client, typewriter | S5-02 (#26), S5-03 (#27) |
| `src/voice/` | Voice overlay and transcriber | S6-01 (#28) |

## Sign-in

Amplify Auth with Cognito only (ADR-005): `src/auth/` wraps `signIn`, `signOut` and `fetchAuthSession` in an `AuthService`, `AuthProvider` exposes the state (`loading`, `signedIn`, `signedOut`) through `useAuth()`, and `RequireAuth` guards `/chat`. `/` goes to `/chat`, so a signed-out visitor lands on `/login`.

- **Tokens** stay in local storage (Amplify's default), so a reload keeps the patient signed in. ID and access tokens last 60 minutes; Amplify refreshes them with the refresh token (`GetTokensFromRefreshToken`) when they are within 5 s of expiry. Sign-out revokes the refresh token and clears storage.
- **API clients** take `getIdToken` from `src/auth` as their token getter and send `Authorization: <ID token>`. It returns `undefined` when signed out and rejects on transient errors.
- **Errors never say whether a username exists** (FR-001): a wrong password and an unknown user get the same message.
- **Config** is build-time: `VITE_USER_POOL_ID` and `VITE_SPA_CLIENT_ID` (see `.env.example`; values from SSM `/sched/<env>/auth/...`). The dev server and tests fall back to the Cognito mock when neither is set; production builds don't.

**The Cognito mock** (`src/mocks/cognito.ts`) answers Amplify's calls to `cognito-idp.us-east-1.amazonaws.com` for the mock app client only; other clients pass through to the network. It checks passwords with real SRP math (`src/mocks/srp.ts`), so only the right password signs in. Users (`src/mocks/cognitoUsers.ts`): `maria.santos` signs in, `new.patient` must set a new password (which this page doesn't offer). Both use the mock-only `MOCK_PASSWORD` from that file. In tests, `configureCognitoMock({ tokenLifetimeSeconds, fault })`, `expireCognitoSessions()` and `cognitoMockStats()` drive it; `src/test/setup.ts` resets it after each test. Amplify keeps its tokens in local storage, so call `localStorage.clear()` between tests that sign in.

## The mock API

`src/mocks` stands in for `POST /api/session` and `POST /api/chat`. Its responses are validated against `@sched/contracts`, and the chat stream keeps the real API's timing: no response headers until the first event (`firstEventMs`, default 1 s), so start a "processing" state on send, not on the response (ADR-007).

- **Dev server:** on by default. `VITE_MOCK_API=off npm run dev -w apps/web` turns it off. In the browser console, `schedMock.set({ chatFault: "mid_stream" })` changes the options (kept in local storage), `schedMock.options()` shows them, and `schedMock.reset()` restores the defaults.
- **Tests:** `src/test/setup.ts` installs it for every test, with no delays and no faults. `configureMockApi({ ... })` from `src/mocks/node` changes options for one test; they reset after each test. `server.use(...)` from the same module overrides a handler.
- **Options** (`src/mocks/options.ts`): `latencyMs`, `firstEventMs`, `eventIntervalMs`; `chatReply` (`tools`, `plain`, `reset`); `chatFault` (`network`, `unauthorized`, `rate_limited`, `unavailable`, `daily_cap`, `mid_stream`); `session` (`upcoming`, `no_upcoming`, `restore`); `sessionFault` (`network`, `unauthorized`, `internal`).

The chat page restores a conversation only if this login session has been using it (FR-014, `src/chat/loginSession.ts`), so `session: "restore"` shows its messages only once local storage's `sched.loginSession` holds `{ sub, conversationId }` with the signed-in user's `sub` (`src/mocks/cognitoUsers.ts`) and `RESTORE_CONVERSATION_ID` (`src/mocks/fixtures.ts`). Otherwise the page starts empty, as it would after a new sign-in.

Production builds contain no mock code: the worker script is served by the dev server only, `main.tsx` loads the mock behind `import.meta.env.DEV`, and `src/auth/session.ts` names the Cognito mock's pool behind the same guard. `build.test.ts` runs the production build in `npm test` and checks `index.html` plus scripts under `assets/`, and that the output has no mock API code, no worker script, and none of the Cognito mock's pool ID, app client ID or password.

## Conventions

- Colors come from the tokens in `src/styles/tokens.css`; `tokens.test.ts` checks every text/background pair against WCAG AA in both themes. Add a pair there when you add a token.
- Pages render their own `<title>` with `pageTitle()`.
- `<main>` scrolls, not the document, so the header and disclaimer stay in view. A page that needs a pinned composer can fill `<main>` with a flex column.
