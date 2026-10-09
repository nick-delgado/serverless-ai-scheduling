# Spike S-3: browser → Amazon Transcribe Streaming (#10)

Throwaway measurement page that feeds [ADR-006](../../docs/adr/0006-voice-transcription.md). It is served only from a local Vite dev server and is never deployed.

**The question.** Can the browser stream its own mic audio to Amazon Transcribe Streaming while the patient talks, with Identity Pool credentials that allow nothing else, and get the final transcript within NFR-002's 2 s (p95) of Send on Chrome (desktop), Safari (macOS), iOS Safari and Android Chrome? Which browser quirks (sample rate, suspended contexts, permission prompts, locking the screen) must #29 handle?

**What the page does.**

1. Signs in a seeded `dev` demo patient with Amplify (`signIn`, then `fetchAuthSession().credentials`), the path #29 ships (r1/Q-1 (b)). The password is typed at run time. The pool IDs come from the git-ignored `.env.local`.
2. "Check role scope" calls `transcribe:ListTranscriptionJobs` with the same credentials and records the refusal (ADR-006's role-scoping item).
3. "Probe 16 kHz AudioContext" records whether `new AudioContext({ sampleRate: 16000 })` is honoured and can take the mic (r1/Q-5).
4. Start: `getUserMedia` → `AudioContext` at the native rate → AudioWorklet (`src/pcm-worklet.ts`, downsampled to 16 kHz s16le, 1600-sample (100 ms) chunks) → `@aws-sdk/client-transcribe-streaming`, loaded with a dynamic `import()` on first use, over the WebSocket (`en-US`, `pcm`, 16000 Hz, no PII redaction, no custom vocabulary; r1/A-2). The stabilization variant adds `EnablePartialResultsStabilization` with stability `high`.
5. Send (or the 60 s auto-send, FR-021) ends the audio with an empty AudioEvent and waits for the server to end the stream. Timing (r1/A-1), all `performance.now()` from the tap: `stop` at Send; `lastFinal` at the last `IsPartial: false` result; latency = lastFinal − stop. Also Send→stream end, tap→WebSocket open and tap→first result, flagged cold (first stream after a page load) or warm. Credentials are fetched before the tap timestamp.
6. A run fails (r1/Q-2) when the stream errors; the socket closes before Send, or after it without a clean code-1000 close; the stream ends with no final result at all; or the stream doesn't end, or its last final arrives, more than 10 s after Send (FR-022). A run whose finals all arrived before Send is a success, counted as 0 ms of stop→final (Nick's decision on PR #225).
7. Runs are kept in the browser's local storage per browser label, so a reload loses nothing, and are exported as redacted JSON into `results/`.

| File | What it is |
|---|---|
| `index.html`, `src/main.ts` | The page: sign-in, run controls, progress, checklist, export |
| `src/capture.ts` | Mic → worklet → Transcribe stream, instrumented; shaped like `apps/web/src/voice/transcriber.ts` (`start` / `stop` / `cancel`) |
| `src/pcm-worklet.ts` | The AudioWorklet: box-filter downsampling to 16 kHz, s16le, 100 ms chunks |
| `src/auth.ts` | Amplify sign-in, Identity Pool credentials, the denied-call check |
| `src/scripts.ts` | The three scripts below, and the run targets |
| `src/redact.ts` | Redaction of account, pool and identity IDs, role sessions, access keys and LAN addresses |
| `config.ts` | Writes `.env.local` from SSM (`/sched/dev/auth/*`), never printing the values |
| `preflight.ts` | Headless Chrome with a synthetic `say` clip as a fake mic: proves the whole path works before a person runs it |
| `bundle-size.ts` | Minified and gzip size of the chunks the Transcribe import adds (r1/A-3) |
| `summarize.ts` | `results/raw-*.json` → `results/summary-<date>.md` |

## The scripts (r1/Q-6 (a))

Fictional people only (CLAUDE.md rule 6). The page shows the script for the selected length; `src/scripts.ts` holds the same text.

**~5 s**

> Hi, this is Maria Santos. Can I see Doctor Lee next Tuesday morning?

**~20 s**

> Hello, this is Walter Haines. I need to move my appointment at Cedar Ridge Health. I'm booked with Doctor Lee on Thursday at two in the afternoon, but I have a conflict at work. Is there anything open on Friday, or early next week, preferably before noon? Thank you.

**~60 s** (a little longer than 60 s read aloud; keep reading until the page auto-sends)

> Good morning, my name is Aisha Rahman, and I'm a patient at Cedar Ridge Health. I'd like to book a dermatology appointment with Doctor Priya Lee, if she's taking new visits this month. I've had a dry, itchy patch on my left forearm for about three weeks now. It isn't painful, and it hasn't spread, but the cream I bought at the pharmacy hasn't helped much. My schedule is a little complicated. On Mondays and Wednesdays I work until five thirty, so those days only work if there's something after six. Tuesdays and Thursdays are better, any time before three in the afternoon. Fridays I can do almost anything, except between eleven and one. If Doctor Lee is fully booked, I'd be happy to see another dermatologist in the clinic instead. Could you also tell me whether I need to bring anything to the visit, like a list of medications? And please send the confirmation to the email address on my profile, not by text message. One more thing: if a slot opens up earlier because someone cancels, I'd like to take it. Thanks so much for your help.

## Run sheet (Nick)

Everything runs from the repo root (after `npm ci`). The phones and the Mac must be on the same Wi-Fi. Allow about 25 minutes per measured browser, plus 10 for each browser with the variant. Transcribe Streaming bills per second of audio; about 45 minutes of audio in total should cost around a dollar (the published us-east-1 rate was about $0.024 per minute; not re-checked).

### 0. Once, on the Mac

```bash
# Pool IDs into the git-ignored spikes/s3-transcribe-browser/.env.local (already written for dev on 2026-10-08):
AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npm run config -w spikes/s3-transcribe-browser
```

Optional check that the whole path works before you speak (headless Chrome, a synthetic clip as the mic, four short streams; the password is read from the root `.env` and never printed). Start the server as in step 1, then in a second terminal:

```bash
npx tsx spikes/s3-transcribe-browser/preflight.ts     # add --env-file <file> if the root .env is elsewhere
```

It should print `"denied": true`, and `"ok": true` for `coldMain`, `warmMain` and `warmStabilized`. (`endIterable` is expected to fail: see the README's findings below.)

### 1. Start the server (only while you run)

```bash
SPIKE_LAN=1 npm run dev -w spikes/s3-transcribe-browser
```

It prints `Network: https://<the Mac's LAN address>:5175/`. Open that address on the phones, and `https://localhost:5175/` on the Mac. If macOS asks whether `node` may accept incoming connections, allow it. Stop the server with Ctrl-C as soon as the runs are done.

### 2. The certificate

The server uses a self-signed certificate (`@vitejs/plugin-basic-ssl`). Accept the warning once per browser:

- **iOS Safari:** "This Connection Is Not Private" → **Show Details** → **visit this website** → **Visit Website**.
- **Android Chrome:** "Your connection is not private" → **Advanced** → **Proceed to … (unsafe)**.
- **Mac browsers:** Chrome and Edge: **Advanced** → **Proceed**. Safari: **Show Details** → **visit this website**. Firefox: **Advanced** → **Accept the Risk and Continue**.

Then check section 1 of the page before anything else: **isSecureContext**, **getUserMedia** and **AudioWorkletNode** must all be ticked (r1/Q-3's "verify first"). If a phone shows `isSecureContext: false` or no `getUserMedia` after accepting the warning, switch to a trusted certificate:

```bash
brew install mkcert && mkcert -install            # creates a local CA
mkdir -p ~/.s3-spike-tls && cd ~/.s3-spike-tls      # outside the repo
mkcert -cert-file cert.pem -key-file key.pem "$(ipconfig getifaddr en0)" localhost
open "$(mkcert -CAROOT)"                            # AirDrop rootCA.pem to the phone
```

- iOS: open the profile from Settings → **Profile Downloaded** → Install, then Settings → General → About → **Certificate Trust Settings** → turn on full trust for the mkcert root.
- Android: Settings → Security → Encryption & credentials → **Install a certificate** → CA certificate.

Restart the server with `SPIKE_LAN=1 SPIKE_TLS_CERT=~/.s3-spike-tls/cert.pem SPIKE_TLS_KEY=~/.s3-spike-tls/key.pem npm run dev -w spikes/s3-transcribe-browser`. Note in the checklist notes which route each phone needed.

### 3. Order

Phones first: **iOS Safari**, then **Android Chrome**. Then **Chrome (desktop)**, **Safari (macOS)**, and last **Firefox** and **Edge** (best effort; Edge isn't installed on this Mac, so install it or mark it "not run").

### 4. Per browser

1. Open the page, accept the certificate, and check section 1. Pick the browser in "Browser being measured" (the page guesses it).
2. Sign in as `maria.santos` with `DEMO_PASSWORD_MARIA` from the root `.env` (any seeded demo patient works). The status should say "Identity Pool credentials ready".
3. Press **Check role scope**. It should show `"denied": true` with an `AccessDeniedException`.
4. Press **Probe 16 kHz AudioContext**. This is the first mic use: note whether a permission prompt appeared (checklist: "Permission prompt on first use").
5. **Main runs** (Variant: main, Deliberate check: none). The progress table counts them: **7 × ~5 s, 7 × ~20 s, 6 × ~60 s**.
   - Pick the length; the script appears.
   - Press **Start**. Wait for "Recording: …" (the timer starts), then read the script at a natural pace.
   - Press **Send** right after the last word (within about a second). For ~60 s, keep reading: the page sends by itself at 1:00.
   - Wait for "OK … ms" or "FAILED …" before the next run. Mixing lengths is fine. If you stumble badly, press Cancel (it isn't recorded) and redo it. Don't cancel a run because it was slow or failed: those are the measurement.
6. **Variant runs, iOS Safari and Chrome (desktop) only:** Variant: **stabilization on**, **5 per length** (15 runs).
7. **Checklist** (section 5; items that can't be tried are "not tried"):
   - After a run, look at the browser's or OS's mic indicator: does it go off after Send? ("Mic indicator turns off after Send")
   - Reload the page, then press Start: does the permission prompt come back? ("Prompt again after reload")
   - **Phones only, one try each:** set Deliberate check to **lock screen mid-recording**, start a ~20 s run, lock the phone for about 5 s, unlock, and press Send if the page is still recording. Then the same with **switch tab mid-recording** (switch to another tab or app for about 5 s). Record what happened in the checklist. These runs never count as failures (r1/Q-2).
   - The sample rates, the context states and the failed-stream count fill in by themselves.
   - Anything else surprising goes in Notes.
8. **Export:** press **Save results to the Mac**. It writes `spikes/s3-transcribe-browser/results/raw-<browser>-<timestamp>.json` on the Mac. If that fails, use **Download JSON** and AirDrop the file into that folder. Exporting twice is fine; the summary merges runs by id.

**Firefox and Edge (r1/A-7):** sign in, check role scope, then up to 3 main runs (one per length is ideal) and export. If a stream can't start at all, note the error in the checklist notes and export anyway.

### 5. When every browser is done

Stop the server (Ctrl-C). Then:

```bash
npx tsx spikes/s3-transcribe-browser/summarize.ts     # writes results/summary-<date>.md
```

Tell the agent the results are in `results/`, with anything you noticed that the page couldn't record (how each phone took the certificate, the permission prompts, the mic indicators).

## Results (2026-10-08)

Summary: [`results/summary-2026-10-08.md`](results/summary-2026-10-08.md). Notes, the export repair and the behaviour findings: [`results/notes-2026-10-08.md`](results/notes-2026-10-08.md). Raw exports: `results/raw-<browser>-<timestamp>.json`. Conclusions: [ADR-006](../../docs/adr/0006-voice-transcription.md) Validation.

- **Main runs:** 80 on the four measured browsers, 20 each, with no failed stream.
- **Stop→final p95:** 156 to 276 ms. **Send→stream end p95:** 197 to 382 ms. NFR-002 allows 2 s.
- **Firefox:** 6 best-effort runs, all fine. **Edge:** not run.

## Results files

An export is the page's JSON, redacted in the browser. **Save results to the Mac** sends it through the dev server's endpoint, which redacts it again with the exact IDs from `.env.local` and refuses a body that doesn't parse; **Download JSON** skips the endpoint. `summarize.ts` refuses a file that doesn't parse and names it.

The first exports (2026-10-08) were damaged by the old account-ID pattern `\b\d{12}\b`, which also matched 12-digit `performance.now()` fractions. Those three didn't parse, so they can't have passed the endpoint and came by Download. They were repaired by dropping each damaged `.<account>` fraction, which loses only sub-millisecond digits, and a search of every committed result for the exact `.env.local` IDs found none. The details are in the notes. `src/redact.ts` now leaves digits after a decimal point alone, and `npm run check -w spikes/s3-transcribe-browser` (`redact.check.ts`) checks that.

## Bundle size (r1/A-3)

```bash
npm run bundle-size -w spikes/s3-transcribe-browser
```

On 2026-10-08, and re-run on 2026-10-09 after the review fixes (the import is unchanged; the entry chunk grew 0.2 KiB):

- **The import adds:** 171,429 B minified / 58,753 B gzip (167.4 / 57.4 KiB), in five chunks.
- **The entry chunk already holds:** `aws-amplify` and the page, 146.7 KiB minified / 44.7 KiB gzip.
- **The worklet:** 1.2 KiB.

## Findings from the pre-flight (before the device runs)
From the agent's checks on 2026-10-08 (headless Chrome 154 on the Mac, synthetic `say` audio; not measurements):

- The demo patient signs in on `dev` and gets Identity Pool credentials (r1/A-8). `ListTranscriptionJobs` with them is refused with `AccessDeniedException`.
- The browser client opens its WebSocket on the path `/stream-transcription-websocket`, the WebSocket action, and Transcribe returns transcripts with those credentials: the browser signs `transcribe:StartStreamTranscriptionWebSocket`.
- Ending the audio iterable loses the final transcript. `@aws-sdk/middleware-websocket`'s `WebSocketFetchHandler` calls `socket.close(1000)` as soon as the input iterable ends, so the server's last results never arrive (`?end=iterable` on the page shows it: no final, stream over ~60 ms after Send). Sending an empty AudioEvent and keeping the iterable open until the response stream ends gets the final ~100–200 ms after Send.
- No Node shims (`Buffer`, `global`) were needed under Vite 8.
