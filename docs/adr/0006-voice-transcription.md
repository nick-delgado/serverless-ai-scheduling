# ADR-006: Voice transcription — browser streams to Amazon Transcribe during recording

- **Status:** Accepted (2026-10-08). Spike S-3 (#10) confirmed it on all four measured browsers; see Validation.
- **Date:** 2026-09-28 (proposed), 2026-10-08 (accepted)
- **Deciders:** Nick Delgado (+ Claude, drafting)
- **Related:** PRD FR-020…FR-024, NFR-002, ADR-005

## Context

The patient taps the mic, grants permission on first use, and talks while an overlay shows the recording time. They tap send, see a "transcribing" spinner, and the text appears as their chat message. Waiting after "send" is the cost the patient feels, so we want it short (NFR-002: ≤ 2 s at p95).

What desk research found about Amazon Transcribe:
- **Streaming** accepts `pcm` (signed 16-bit little-endian), `ogg-opus`, or `flac`, at 8–48 kHz. AWS recommends PCM.
- Streaming is designed for **real-time delivery**. AWS guidance is to send 50–200 ms chunks at roughly real-time pace, not the whole file at once.
- **Batch** jobs accept browser-native containers (WebM, MP4, …) but take seconds to tens of seconds even for short clips.
- Browsers don't agree on a recording format. Chrome's `MediaRecorder` produces WebM/Opus; Safari produces MP4/AAC. Neither is directly accepted by streaming.

## Options considered

1. **Browser → Transcribe Streaming directly, while recording.**
   - An AudioWorklet captures the mic and downsamples to 16 kHz PCM.
   - `@aws-sdk/client-transcribe-streaming` (WebSocket in the browser) streams ~100 ms chunks, using temporary credentials from the Cognito Identity Pool (ADR-005).
   - On "send", the client ends the audio stream and waits for the final (non-partial) results.
   - Pros: transcription finishes about as soon as the patient stops talking. Works the same across browsers. **No audio ever touches our backend or storage.**
   - Cons: the browser needs AWS credentials (tightly scoped); it's more client code.
2. **Record the whole clip → POST to a Lambda → Lambda streams it to Transcribe.**
   - Pros: credentials stay on the server.
   - Cons: to follow AWS guidance, the Lambda must send audio at real-time pace. A 20 s clip means about 20 s of spinner after "send". That's unacceptable UX. Sending faster than real-time works against the service's intended use.
3. **Record → presigned S3 upload → batch `StartTranscriptionJob` → poll.**
   - Pros: simplest audio handling (browser formats accepted).
   - Cons: high and variable latency; audio is stored (privacy surface); more moving parts (S3 events, polling).

## Decision

**Option 1.** The browser streams PCM to Transcribe Streaming while the patient speaks, authorized by Identity Pool credentials whose only permission is `transcribe:StartStreamTranscriptionWebSocket`.

UX mapping:

| UI state | What's happening |
|---|---|
| Mic tap (first time) | `getUserMedia` permission prompt. If denied: inline explanation plus "type instead". |
| Recording overlay (timer mm:ss, Cancel, Send) | AudioWorklet → PCM chunks → Transcribe WebSocket. Partial results are buffered. At **60 s** the recording stops and is sent as if Send were pressed (FR-021). |
| "Transcribing…" spinner | End the audio with an empty AudioEvent, keep the stream open, and wait until the server ends it with the final result segments. |
| Message appears | The final transcript is posted as the patient's chat message, then sent to the agent like typed text. |
| Cancel | Close the stream and discard everything. |

- Language `en-US` for v1.
- Transcribe's PII redaction stays **off**: the agent needs names and dates. Transcripts are stored only as chat messages, with a 30-day TTL (ADR-004).

## Consequences

- There's no `/transcribe` Lambda, which means less backend code and cost.
- The browser SDK adds bundle weight, so we lazy-load it only when the mic is first used. In the spike's `vite build`, the dynamic `import("@aws-sdk/client-transcribe-streaming")` adds **167.4 KiB minified / 57.4 KiB gzip**, in five chunks. The entry chunk already holds `aws-amplify`: 146.5 KiB minified / 44.6 KiB gzip with the spike page. No Node shims (`Buffer`, `global`) were needed under Vite 8.
- Browser quirks the spike found on real devices, which #29 must handle:
  - Every browser's native `AudioContext` ran at 48 kHz, so the worklet downsamples.
  - Safari (macOS and iOS) and Firefox create the context suspended when it's created after an `await` in the tap handler; `resume()` starts it.
  - Safari and Firefox ask for mic permission again after a reload.
  - On iOS, locking the screen or leaving Safari mid-recording silently drops the audio for as long as the page is hidden, while the stream stays open.
- **Revisit if** a browser shows more than one failed stream in #29's AC6 runs, or on mobile Safari in use. The fallback is still option 3 (batch) for that browser only, behind the same `Transcriber` interface. The spike gave no reason to use it: 0 failed streams in 80 measured runs.

## Validation (spike S-3, #10, `spikes/s3-transcribe-browser/`)

Nick read three fixed scripts (~5 s, ~20 s, ~60 s; synthetic names) into each device on 2026-10-08. The spike page served them from a local Vite dev server over HTTPS on the LAN and was never deployed. It signed in a seeded `dev` demo patient with Amplify and streamed with that patient's Identity Pool credentials. The settings were AudioWorklet capture, 16 kHz s16le, 1600-sample (100 ms) chunks, `en-US`, no PII redaction, no custom vocabulary and no stabilization.

Results: [summary](../../spikes/s3-transcribe-browser/results/summary-2026-10-08.md), [notes](../../spikes/s3-transcribe-browser/results/notes-2026-10-08.md), raw exports alongside them.

- **Latency.** Stop→final runs from Send, or the 60 s auto-send, to the last `IsPartial: false` result. p95 is nearest rank over each browser's 20 main runs (7 × ~5 s, 7 × ~20 s, 6 × ~60 s).

  | Browser | ok / runs | failed | stop→final p95 | median / max per length (5 s; 20 s; 60 s) | final before Send | Send→stream end p95 |
  |---|---|---|---|---|---|---|
  | iOS Safari | 20 / 20 | 0 | 218 ms | 0 / 218; 145 / 154; 157 / 233 | 7 | 252 ms |
  | Android Chrome | 20 / 20 | 0 | 276 ms | 120 / 230; 145 / 253; 203 / 285 | 5 | 382 ms |
  | Chrome (desktop) | 20 / 20 | 0 | 235 ms | 68 / 226; 129 / 168; 175 / 239 | 6 | 366 ms |
  | Safari (macOS) | 20 / 20 | 0 | 156 ms | 139 / 156; 53 / 244; 137 / 155 | 3 | 197 ms |
  | Firefox (best effort) | 6 / 6 | 0 | 164 ms | 13 / 164; 0 / 100; not run | 3 | 192 ms |
  | Edge (best effort) | not run | | | | | |

  Every measured browser is far inside NFR-002's 2 s. "Final before Send" counts runs in which Transcribe sent the last final during the pause before Send; those count as 0 ms. Send→stream end is what a patient waits for when `stop()` resolves at the end of the stream, and it stays under 0.4 s at p95. Warm tap→WebSocket open on the measured browsers was 204 to 545 ms (median). The cold first stream on iOS took 3.6 s, 3.3 s of it in `getUserMedia` (the permission prompt).
- **Reliability (r1/Q-2's rule).** There were no failed streams on any browser: no errors, no socket closed early and no final later than 10 s. The rule needs at most one per measured browser, so the decision is **Accepted** for all four, and no browser takes the batch fallback.
- **Role scoping.** On every browser, the same credentials were refused `transcribe:ListTranscriptionJobs` (`AccessDeniedException`). The browser client opens its socket on `/stream-transcription-websocket`, so it signs `transcribe:StartStreamTranscriptionWebSocket`, the one action the Identity Pool role allows.
- **Stabilization variant** (`EnablePartialResultsStabilization`, stability `high`; 5 per length on iOS Safari and Chrome (desktop)): no gain. iOS Safari's stop→final p95 per length was 149, 188 and 237 ms against the main runs' 218, 154 and 233 ms, and Chrome's Send→stream end p95 was 442 ms against 366 ms.
- **Behaviour checklist (r1/Q-5):**
  - Every browser honoured `new AudioContext({ sampleRate: 16000 })` and it accepted the mic. The measured path used the native 48 kHz context and downsampled in the worklet.
  - The mic indicator went off after Send everywhere.
  - Android Chrome kept recording through a screen lock and a tab switch. iOS Safari kept the stream but sent no audio while hidden.

### For #29

- **End of audio:** send an empty `AudioEvent` and keep the input iterable open until the response stream ends. Ending the iterable makes `@aws-sdk/middleware-websocket`'s `WebSocketFetchHandler` close the socket at once (`socket.close(1000)`), and the final results are lost. In the pre-flight that gave no final and an end about 60 ms after Send.
- **Signed action:** `transcribe:StartStreamTranscriptionWebSocket`, confirmed with Identity Pool credentials. #29's role and AC4 work as written.
- **Stabilization:** leave it off (#29 r1/A-7). The variant showed no benefit.
- **Chunk size:** keep 1600 samples (100 ms) at 16 kHz (#29 r1/A-6).
- **Clip mix for AC6:** reuse the spike's three scripts and its mix of 7 × ~5 s, 7 × ~20 s and 6 × ~60 s. Report Send→stream end beside stop→final, since a third of short clips finalise before Send.
- **Sample rate:** keep the native-rate context with worklet downsampling, the path measured here. A 16 kHz context worked everywhere but wasn't measured for accuracy.
- **AudioContext:** create it in the tap handler and always `await ctx.resume()`, because Safari and Firefox create it suspended after the earlier awaits.
- **Page hidden mid-recording:** on iOS the audio stops silently while the stream lives on. #29 should listen for `visibilitychange` and treat hidden-while-recording as an error (`onError`, then cancel), or warn the patient. Nick decides which in #29.
- **Code to move:** `src/capture.ts` already has the `Transcriber` shape (`start` / `stop` / `cancel`, credentials fetched before the tap, chunks held until the socket opens), and `src/pcm-worklet.ts` is about 100 lines. Both are worth moving into `apps/web` as a starting point, with the downsampler unit-tested there (#29 r1/A-6).
