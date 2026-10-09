# 2026-10-09 — The mic streams for real, and a build flag carries the stopwatch to the phones

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #29 (S6-02), #28, #10, ADR-005, ADR-006, PRD FR-020–FR-024, NFR-002, NFR-006

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

## Evidence

- Tests: the real Transcriber against a fake Transcribe client and a fake mic; `useRecording` giving up 10 s after Send closes the fake client; the worklet run in jsdom with stubbed globals; and both production builds.
- AC4 (role check on the ephemeral env) and AC6 (timed runs on four browsers) are pending Nick's runs; their numbers will be added here and in the PR.

## What's next

Nick runs AC4 and AC6 on the `voice29` env, then the env is torn down. #36 checks voice end to end on `dev`.
