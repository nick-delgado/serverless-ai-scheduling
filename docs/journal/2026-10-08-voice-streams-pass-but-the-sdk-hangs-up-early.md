# 2026-10-08 — Browser voice passes on four browsers, but ending the SDK's audio stream the obvious way loses the transcript

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #10 (spike S-3), PR #225, #29, ADR-006, PRD FR-020–FR-023, NFR-002, NFR-006

## What happened

ADR-006 had been Proposed since the first day. Its plan was that the browser streams its own mic audio to Amazon Transcribe Streaming while the patient talks, using Identity Pool credentials that can do nothing else. Spike S-3 was meant to show whether that holds on real phones before #29 builds the voice UI on it.

The agent built a local-only measurement page (`spikes/s3-transcribe-browser/`):

- Amplify signs in a seeded `dev` demo patient, and the page streams with that patient's Identity Pool credentials.
- An AudioWorklet downsamples the 48 kHz mic to 16 kHz PCM in 100 ms chunks.
- The Transcribe client is lazy-loaded.
- The page has timings, a behaviour checklist, run counters, and a redacted JSON export.

Before Nick spoke a word, the agent drove the page in headless Chrome with a synthetic `say` clip as a fake microphone. That run showed the sign-in, the denied `ListTranscriptionJobs` call, and a transcript coming back over `/stream-transcription-websocket`. The browser signs `StartStreamTranscriptionWebSocket`, the one action the role allows, which #29's readiness review had flagged as unverified.

Nick then read three fixed scripts (~5 s, ~20 s, ~60 s) into iOS Safari and Android Chrome on his phones, then Chrome and Safari on the Mac, 20 runs each. He added 15 stabilization-variant runs on iOS Safari and on desktop Chrome, and 6 best-effort runs on Firefox. Edge wasn't installed, so it wasn't run.

The result was clear:

- **Failures:** 0 failed streams in 80 measured runs.
- **Stop→final p95:** between 156 ms (macOS Safari) and 276 ms (Android Chrome), against NFR-002's 2 s.
- **Send→end of stream p95:** 197 to 382 ms. That's what a patient actually waits for.

By the rule Nick set (r1/Q-2: at most one failed stream per browser), ADR-006 is Accepted for all four browsers, with no batch fallback and no follow-up issues.

## Why we chose what we chose

- **Ending the audio with an empty AudioEvent and keeping the input open until the server ends the stream.** The obvious alternative is ending the async iterable. It loses the transcript: see below.
- **Stabilization at `high` for the variant** (r1/A-2 left the level open). We picked the level that favours speed, since speed is what we measured. It made no difference: iOS Safari's p95 per length was 149, 188 and 237 ms against 218, 154 and 233 ms without it. So #29 keeps it off.
- **Counting a final that arrived before Send as 0 ms, and reporting Send→stream end beside it.** In 3 to 7 of each browser's 20 runs, Transcribe finalised during the pause before Nick pressed Send. The alternatives were a negative latency, which is meaningless as a wait, or dropping those runs, which would hide them. Send→stream end is what `stop()` actually waits for, so #29's AC6 should report it too. The same choice decides the reliability count, since r1/Q-2 didn't say whether a run with no final after Send fails. Nick decided on PR #225 that these runs are successes: their sockets closed cleanly and every transcript ends with its script's last words.
- **A synthetic-audio pre-flight in headless Chrome.** It proved the path before Nick spent an evening reading scripts into phones. Its numbers aren't measurements, and r1/Q-6 (a) kept generated audio out of the results.
- **Firefox's 6 runs are all reported,** although r1/A-7 says "up to 3". They're best effort either way.
- **For #29, the agent recommends treating "page hidden while recording" as an error on every browser.** iOS gives no other signal that the audio stopped. Nick decides in #29.

## What surprised us

- **The SDK hangs up on its own final results.** In `@aws-sdk/middleware-websocket`, `WebSocketFetchHandler` calls `socket.close(1000)` the moment the audio iterable ends. The server never gets to send the last transcript. In the pre-flight, ending the iterable gave no final at all and a stream that was over about 60 ms after Send. Sending Transcribe's end-of-audio signal (an empty AudioEvent) and keeping the iterable open until the response stream ends brought the final 108 to 204 ms after Send. A Transcriber written the natural way would drop every final that arrives after Send, so its transcript would be empty or cut short unless the speaker paused before pressing Send, and an empty one makes FR-023 show "I didn't catch that".
- **iOS goes deaf without saying so.** When the screen locked, or Safari went to the background mid-recording, the stream stayed open, the mic indicator stayed on and no error fired. The audio for those 6 to 8 seconds simply never arrived: 16.4 s sent of 22.7 s recorded. Android Chrome kept recording through both.
- **Safari and Firefox start the context suspended even inside the tap handler.** By the time the handler creates the `AudioContext`, it has already awaited the SDK import and `getUserMedia`, so the user activation is gone. `resume()` fixes it.
- **Our own redaction corrupted the results.** The exports' account-ID pattern `\b\d{12}\b` also matched the 12 fractional digits of Chrome's and Safari's `performance.now()` values. It turned `6744.399999999674` into `6744.<account>`, and the summary script couldn't parse three of the five files. The agent repaired them by dropping the damaged fractions, which lose only sub-millisecond digits: 31, 105 and 7 values. The pattern now skips digits after a decimal point, `redact.check.ts` fails on the old one, and the same one-line fix went into S-2's redactor.

## Evidence

- Results: `spikes/s3-transcribe-browser/results/summary-2026-10-08.md`, `notes-2026-10-08.md`, and five `raw-*.json` exports.
- Per browser, main runs (ok / runs, stop→final p95, Send→end p95):
  - iOS Safari: 20/20, 218 ms, 252 ms.
  - Android Chrome: 20/20, 276 ms, 382 ms.
  - Chrome (desktop): 20/20, 235 ms, 366 ms.
  - Safari (macOS): 20/20, 156 ms, 197 ms.
  - Firefox: 6/6, 164 ms, 192 ms.
- Bundle size: the lazy Transcribe import adds 167.4 KiB minified / 57.4 KiB gzip, next to a 146.7 / 44.7 KiB entry chunk that holds `aws-amplify` (`npm run bundle-size -w spikes/s3-transcribe-browser`).
- Role scoping: `ListTranscriptionJobs` was refused with `AccessDeniedException` on all five browsers.
- Redaction check: `npm run mutate` with the old pattern restored is KILLED by `redact.check.ts` ("redaction changed a number").

## What's next

- #29 builds the real Transcriber from ADR-006's "For #29" list: the empty-AudioEvent ending, `resume()`, hidden-page handling, stabilization off, and the same clip mix for AC6.
- Edge stays unmeasured until someone has it installed. NFR-006 calls it best effort.
