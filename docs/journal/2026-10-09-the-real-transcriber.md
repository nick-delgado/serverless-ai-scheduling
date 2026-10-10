# 2026-10-09 — The mic streams for real, and a build flag carries the stopwatch to the phones

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #29 (S6-02), #28, #10, #36, ADR-005, ADR-006, PRD FR-020–FR-024, NFR-002, NFR-006

## What happened

Spike S-3 (#10) showed that a browser can stream its own mic to Amazon Transcribe and get the final text back in a few hundred milliseconds. #29 turned the spike's page into the app's `Transcriber`, behind the interface #28's recording overlay already talks to. The agent built it; Nick's two readiness rounds on the issue had settled the questions in advance.

The agent built these parts (`apps/web/src/voice/transcribe/`):

- **`pcm.ts`:** the spike's downsampler, as a pure module with tests. It averages 48 kHz down to 16 kHz, encodes signed 16-bit little-endian, and emits 1600-sample (100 ms) chunks.
- **`pcm-worklet.ts`:** the AudioWorklet, which only feeds `pcm.ts` and answers a `flush`.
- **`mic.ts`:** the AudioContext, `getUserMedia`, `resume()` before `addModule`, and the error kinds.
- **`streamClient.ts`:** the only module that imports the Transcribe SDK, loaded on the first mic tap.
- **`RealTranscriber.ts`:** start, Send, Cancel and errors.

`TranscriberContext` now picks the real Transcriber in any build with the Identity Pool ID, and every deployed build has one. On the auth side, Amplify is configured with the Identity Pool. Voice gets credentials through a new `getAwsCredentials`, while `getIdToken` reads the token provider alone (r1/Q-1 (a)). A test with a failing Cognito Identity endpoint shows the chat token still arrives.

Two rules from the spike carry the design:

- **Send ends the audio, not the input.** On Send, the generator yields an empty `AudioEvent` and then waits until Transcribe ends the response stream. If the iterable ended instead, the SDK would close the socket and drop the finals. A test with a fake Transcribe client shows the empty event and an input that stays open until the response ends.
- **A hidden page is an error.** On iOS the audio stops silently while the page is hidden. Nick chose to treat hidden-while-recording as an error on every browser (r2/Q-1 (a)). The overlay shows its retry / type-instead, and the stream closes.

For the latency runs on Nick's phones, Nick chose an opt-in build flag (r2/Q-2 (a)). With `VITE_VOICE_TIMING=1`, the build gets a timing record and a panel. In the panel, the tester labels each run, reads the clip's script, and exports the record as JSON. A role-check button there runs AC4's `ListTranscriptionJobs` call with the same credentials. Any other build contains none of it. `build.test.ts` builds the app twice to show that, and the minifier drops the dead branches and their lazy chunks.

## Why we chose what we chose

The issue left these choices to the agent:

- **Missing config:** a build without the Identity Pool ID keeps the mic button, disabled, with "Voice input isn't set up on this site. You can type your message." The dev server on the Cognito mock keeps the `MockTranscriber`, because the mock's tokens can't be exchanged for AWS credentials (r1/A-3).
- **When `start()` resolves:** once the mic is capturing, not once the socket is open. Chunks queue until the stream opens, so the overlay's timer starts with the audio. A credentials or SDK failure then reaches the overlay through `onError` a moment after recording starts, rather than as a rejected `start()`.
- **Mic errors:** `NotAllowedError` and `SecurityError` are `denied`. `NotFoundError` and `OverconstrainedError`, or no `mediaDevices` or AudioWorklet (an insecure context), are `unavailable`. Anything else, such as a mic another app holds, is `failed`.
- **A context slower than 16 kHz** isn't upsampled. The PCM passes through at the context's own rate, and that rate goes to Transcribe. No measured browser ran below 48 kHz.
- **Exception events:** a Transcribe exception that arrives as a stream event is treated like a thrown one.
- **The role check** uses `@aws-sdk/client-transcribe` (`ListTranscriptionJobs`, as the spike did), added as a dev dependency. Only the timing panel loads it, so no other build ships it.
- **Classifying runs:** a cancel at least 9.5 s after Send is the overlay's 10 s timer giving up, so the run counts as a `timeout` failure. An earlier cancel is the tester's, and it doesn't count. The SDK ends its response stream without an error when the socket closes. So a socket that drops after Send, with some finals already in, still counts as `ok`. The record keeps the transcript, which shows whether it ends with the script's last words.
- **The scripts** are copied from the spike into the app, so the phone shows what to read. A test compares the copy with the spike's file.

## What surprised us

- **jsdom's `DOMException` isn't an `Error`.** The first mic tests mapped every permission error to `failed`, because `instanceof Error` was false. The code now reads `name` from any object, which is also safer on older engines.
- **`Amplify.Auth.getTokens` isn't on the installed facade.** In this aws-amplify version, the singleton exposes `getTokens` directly. It's the same call that `fetchAuthSession` makes first.
- **The SDK's WebSocket path doesn't survive minification as text.** The lazy-chunk check uses `StartStreamTranscription` instead, the command's name, which does.

## What broke on the first deploy

The `voice29` env went up, and before recording anything Nick signed in on desktop Chrome. Cognito answered 200, but `POST /api/session` came back 401 and the app sent him to the sign-in page. The request had no `Authorization` header at all.

The coordinating session's first guess was the new token path: `getIdToken` now calls `Amplify.getTokens` rather than `fetchAuthSession`. The agent read the installed aws-amplify (6.22.1) and ruled it out:

- `Amplify.getTokens` reads the same global context that `Amplify.configure` sets, and calls the same Cognito token provider that `fetchAuthSession` calls first.
- There is one copy of `@aws-amplify/core`.
- `getIdToken`'s tests already ran real Amplify against the Cognito mock, refresh and a failing Cognito Identity endpoint included.

The real cause was that nothing ever called `getIdToken`. `ChatPage` takes its API client from `ChatApiContext`, whose default sends no token, and no route provided another one. The comment at that default said #36 would. That gap was already on `main`: any deployed build would have been a 401 on its first request. No deployed build had run the full sign-in-then-chat path since #25 and #26 merged.

The tests missed it because every page test either injects its own client or runs against the mock API, which ignores `Authorization`.

Nick moved that one criterion of #36 into #29. The `/chat` route now wraps the page in `ChatApiContext` with `createChatApi({ getToken: getIdToken })` (`apps/web/src/app/routes.tsx`). A new test, `routes.token.test.tsx`, runs the real route tree with the real auth service (SRP against the Cognito mock). It sees the session call and a chat turn both carry the ID token. It fails with the provider removed, with the getter removed, or with `ChatPage` ignoring the context. The same file shows that a 401 on a chat turn signs the patient out to `/login`, through #27's handling.

The header is the raw ID token, as `chat/api.ts` and the API's Cognito authorizer expect, not `Bearer <token>`.

## Evidence

- Tests: the real Transcriber against a fake Transcribe client and a fake mic; `useRecording` giving up 10 s after Send closes the fake client; the worklet run in jsdom with stubbed globals; and both production builds.
- **AC6:** Nick read the spike's three scripts into each browser on `voice29`, on 2026-10-09: 7 × ~5 s, 7 × ~20 s and 6 × ~60 s, so 20 counted runs per browser. The table comes from the timing panel's exports, which the agent re-derived from the raw runs. p95 is nearest rank over each browser's 20 runs, and a final before Send counts as 0 ms.

| Browser | ok / counted runs | failed | stop→final p95 | Send→stream end p95 | finals before Send | slowest run (stop→final) |
|---|---|---|---|---|---|---|
| Chrome (desktop) | 20 / 20 | 0 | 205 ms | 325 ms | 0 | 250 ms |
| Safari (macOS) | 20 / 20 | 0 | 183 ms | 209 ms | 2 | 233 ms |
| iOS Safari | 20 / 20 | 0 | 243 ms | 266 ms | 0 | 1235 ms |
| Android Chrome | 20 / 20 | 0 | 270 ms | 431 ms | 0 | 272 ms |
| Firefox, Edge (best effort) | not run | | | | | |

  - **Failures:** none, 0 failed streams in 80 counted runs. Every measured browser is far inside NFR-002's 2 s.
  - **Transcripts:** every 5 s and 20 s transcript ends with its script's last words, so no socket dropped mid-answer unnoticed. The 60 s ones stop where the auto-send cut the script.
  - **The one slow run:** a 60 s clip on iOS whose last final came 1.2 s after the auto-send. It's still well under 2 s, and it sits above the p95.
  - These numbers are in line with the spike's (156 to 276 ms stop→final p95), now on the shipped bundle.
- **Hidden-page checks:** Nick locked the screen or switched apps mid-recording once on the iPhone and once on Android. Each time he saw the FR-024 error with Record again / Type instead, and each export records the run as `failed` with `failure: hidden`, marked deliberate and left out of the counts.
- **AC4:** the deployed `sched-voice29-auth` template gives the Identity Pool role one inline policy, `transcribe-streaming-only`, with the single action `transcribe:StartStreamTranscriptionWebSocket`, no managed policies, and trust only for authenticated identities of its own pool. With the same signed-in credentials that streamed the transcripts above, the panel's `transcribe:ListTranscriptionJobs` call was refused with `AccessDeniedException (HTTP 400)` on all four browsers.
- **No follow-up issues:** no browser missed 2 s or had more than one failed stream, so ADR-006's "Revisit if" didn't trigger.
- **The raw exports aren't committed:** they stay on Nick's machine, and this table summarises them.

## What's next

`voice29` is torn down once Nick has no more checks for it. #36, now without its token-wiring criterion, checks voice end to end on `dev` once this is deployed there.
