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
| `src/voice/` | Mic button, recording overlay, the `Transcriber` interface, `MockTranscriber`, and the real-or-mock factory | S6-01 (#28), S6-02 (#29) |
| `src/voice/transcribe/` | The real Transcriber: AudioWorklet PCM → Amazon Transcribe Streaming, and the opt-in timing panel | S6-02 (#29) |

## Sign-in

Amplify Auth with Cognito only (ADR-005): `src/auth/` wraps `signIn`, `signOut` and `fetchAuthSession` in an `AuthService`, `AuthProvider` exposes the state (`loading`, `signedIn`, `signedOut`) through `useAuth()`, and `RequireAuth` guards `/chat`. `/` goes to `/chat`, so a signed-out visitor lands on `/login`.

- **Tokens** stay in local storage (Amplify's default), so a reload keeps the patient signed in. ID and access tokens last 60 minutes; Amplify refreshes them with the refresh token (`GetTokensFromRefreshToken`) when they are within 5 s of expiry. Sign-out revokes the refresh token and clears storage.
- **API clients** take `getIdToken` from `src/auth` as their token getter and send `Authorization: <ID token>`. It returns `undefined` when signed out and rejects on transient errors.
- **Errors never say whether a username exists** (FR-001): a wrong password and an unknown user get the same message.
- **Config** is build-time: `VITE_USER_POOL_ID` and `VITE_SPA_CLIENT_ID` (see `.env.example`; values from SSM `/sched/<env>/auth/...`). The dev server and tests fall back to the Cognito mock when neither is set; production builds don't. The third ID, `VITE_IDENTITY_POOL_ID`, is optional and only for voice: with it, Amplify is configured with the Identity Pool, and `getAwsCredentials` (also in `src/auth`) returns the patient's Transcribe-only credentials. `getIdToken` reads the token provider alone, so text chat keeps working when Cognito can't issue AWS credentials. It's ignored on the mock fallback. `scripts/deploy-web.sh` passes all three from SSM.

**The Cognito mock** (`src/mocks/cognito.ts`) answers Amplify's calls to `cognito-idp.us-east-1.amazonaws.com` for the mock app client only; other clients pass through to the network. It checks passwords with real SRP math (`src/mocks/srp.ts`), so only the right password signs in. Users (`src/mocks/cognitoUsers.ts`): `maria.santos` signs in, `new.patient` must set a new password (which this page doesn't offer). Both use the mock-only `MOCK_PASSWORD` from that file. In tests, `configureCognitoMock({ tokenLifetimeSeconds, fault })`, `expireCognitoSessions()` and `cognitoMockStats()` drive it; `src/test/setup.ts` resets it after each test. Amplify keeps its tokens in local storage, so call `localStorage.clear()` between tests that sign in.

## The mock API

`src/mocks` stands in for `POST /api/session` and `POST /api/chat`. Its responses are validated against `@sched/contracts`, and the chat stream keeps the real API's timing: no response headers until the first event, so start a "processing" state on send, not on the response (ADR-007). A turn that continues a conversation sends its first event after `firstEventMs` (default 1 s). A turn that starts one sends its `conversation` event after `latencyMs`, as the real API does once the message is stored, and the reply `firstEventMs` later; its `rate_limited` and `unavailable` faults then answer 200 with that event and an `error` (#160).

- **Dev server:** on by default. `VITE_MOCK_API=off npm run dev -w apps/web` turns it off. In the browser console, `schedMock.set({ chatFault: "mid_stream" })` changes the options (kept in local storage), `schedMock.options()` shows them, and `schedMock.reset()` restores the defaults.
- **Tests:** `src/test/setup.ts` installs it for every test, with no delays and no faults, and gives `fetch` a connection of its own for each request (`connectionPerRequest` in `src/mocks/node.ts`, #206). `configureMockApi({ ... })` from `src/mocks/node` changes options for one test; they reset after each test. `server.use(...)` from the same module overrides a handler.
- **Options** (`src/mocks/options.ts`): `latencyMs`, `firstEventMs`, `eventIntervalMs`; `chatReply` (`tools`, `plain`, `reset`); `chatFault` (`network`, `unauthorized`, `rate_limited`, `unavailable`, `daily_cap`, `mid_stream`); `session` (`upcoming`, `no_upcoming`, `restore`); `sessionFault` (`network`, `unauthorized`, `internal`).

The chat page restores a conversation only if this login session has been using it (FR-014, `src/chat/loginSession.ts`), so `session: "restore"` shows its messages only once local storage's `sched.loginSession` holds `{ sub, conversationId }` with the signed-in user's `sub` (`src/mocks/cognitoUsers.ts`) and `RESTORE_CONVERSATION_ID` (`src/mocks/fixtures.ts`). Otherwise the page starts empty, as it would after a new sign-in.

Production builds contain no mock code: the worker script is served by the dev server only, `main.tsx` loads the mock behind `import.meta.env.DEV`, and `src/auth/session.ts` names the Cognito mock's pool behind the same guard. `build.test.ts` runs the production build in `npm test` and checks `index.html` plus scripts under `assets/`, and that the output has no mock API code, no worker script, and none of the Cognito mock's pool ID, app client ID or password. For voice it checks that the entry chunk leaves out the Transcribe Streaming SDK (another chunk has it), that the `MockTranscriber` is left out, and, with a second build, that the timing code is there only with `VITE_VOICE_TIMING=1`.

## Voice input

The mic sits in the composer (`ChatPage` passes `VoiceInput` as `Composer`'s `accessory`). It talks only to a `Transcriber` (`src/voice/transcriber.ts`), which owns the mic permission and the audio: `start()` asks for the mic and rejects with a `TranscriberError` (`denied`, `unavailable` or `failed`), and its session's `stop()` resolves with the final transcript. The overlay starts the m:ss timer when `start()` resolves, sends at 60 s, waits 10 s for the transcript, then shows the FR-024 error. The level dot follows `onLevel`; it pulses until the first level arrives, so a Transcriber that reports none still shows that it's recording. The transcript goes through `useChat().send` like typed text.

`TranscriberContext` picks the Transcriber:

- **A build with the Identity Pool ID** (every deployed build): the `RealTranscriber` (`src/voice/transcribe/`, ADR-006). `start()` creates the `AudioContext` at the tap, loads the Transcribe Streaming SDK (a lazy chunk, first use only), fetches the Identity Pool credentials and asks for the mic; an AudioWorklet downsamples to 16 kHz s16le in 100 ms chunks, which wait until the WebSocket opens. Send ends the audio with an empty `AudioEvent` and `stop()` resolves when Transcribe ends the stream, with the final results joined. A stream error, the mic track ending, or the page becoming hidden while recording calls `onError` (the overlay's FR-024 error); nothing is retried. Cancel closes the socket and discards everything.
- **Dev server without it:** a `MockTranscriber` with no audio. Tapping the mic shows "Starting…" for 0.3 s in place of the browser's prompt, the level dot moves, and about 1 s after Send it "hears" a fixed sample sentence (`SAMPLE_TRANSCRIPT`). There are no console controls; to try denial, a missing mic, a failure or a transcript that never comes, change `DEV_MOCK_OPTIONS` in `src/voice/TranscriberContext.ts` locally (`denied`, `unavailable`, `error`, `neverFinal`, `transcript`, `delayMs`).
- **Any other build without it:** no Transcriber, so the mic shows disabled with "Voice input isn't set up on this site." The mock isn't in the bundle.
- **Tests:** wrap the page in `<TranscriberContext.Provider value={new MockTranscriber({ ... })}>`. The mock records `starts` and each session's `state` (`recording`, `stopped`, `cancelled`), and a test can change `options` between recordings. The `RealTranscriber`'s own tests inject a fake Transcribe client and a fake mic (`src/voice/transcribe/testing.ts`).

**Timing builds** (#29's latency runs): `VITE_VOICE_TIMING=1 scripts/deploy-web.sh <env>` compiles in a timing record and a panel pinned to the top of the page: label each run (browser, clip, deliberate check), read the clip's script, see each browser's stop→final and Send→stream end p95 and failed streams, download or copy the record as JSON, and run the role check (`transcribe:ListTranscriptionJobs` with the voice credentials, which must be denied). Runs stay in that browser's local storage until exported. Other builds contain none of it.

## Conventions

- Colors come from the tokens in `src/styles/tokens.css`; `tokens.test.ts` checks every text/background pair against WCAG AA in both themes. Add a pair there when you add a token.
- Pages render their own `<title>` with `pageTitle()`.
- `.visually-hidden` (text for screen readers only) is global, in `src/styles/global.css`.
- `<main>` scrolls, not the document, so the header and disclaimer stay in view. A page that needs a pinned composer can fill `<main>` with a flex column.
