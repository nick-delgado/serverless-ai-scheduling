# ADR-006: Voice transcription — browser streams to Amazon Transcribe during recording

- **Status:** Proposed. Pending spike S-3.
- **Date:** 2026-09-28
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

## Decision (proposed)

**Option 1.** The browser streams PCM to Transcribe Streaming while the patient speaks, authorized by Identity Pool credentials whose only permission is `transcribe:StartStreamTranscriptionWebSocket`.

UX mapping:

| UI state | What's happening |
|---|---|
| Mic tap (first time) | `getUserMedia` permission prompt. If denied: inline explanation plus "type instead". |
| Recording overlay (timer mm:ss, Cancel, Send) | AudioWorklet → PCM chunks → Transcribe WebSocket. Partial results are buffered. Recording auto-stops at **60 s**. |
| "Transcribing…" spinner | End the stream, then wait for the final result segments. |
| Message appears | The final transcript is posted as the patient's chat message, then sent to the agent like typed text. |
| Cancel | Close the stream and discard everything. |

- Language `en-US` for v1.
- Transcribe's PII redaction stays **off**: the agent needs names and dates. Transcripts are stored only as chat messages, with a 30-day TTL (ADR-004).

## Consequences

- There's no `/transcribe` Lambda, which means less backend code and cost.
- The browser SDK adds bundle weight. We lazy-load it only when the mic is first used.
- Safari AudioWorklet and sample-rate quirks need testing on real devices.
- **Revisit if** the spike shows WebSocket reliability problems on mobile Safari. The fallback is option 3 (batch) for that browser only, behind the same `Transcriber` interface.

## Validation (spike S-3, `spikes/s3-transcribe-browser/`)

- Measure the time from stop to final transcript for 5 s, 20 s, and 60 s clips on Chrome, Safari, and iOS Safari.
- Confirm the Identity Pool role scoping works and nothing else is allowed.
- Record the bundle-size impact.
