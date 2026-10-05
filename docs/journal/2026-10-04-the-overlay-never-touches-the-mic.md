# 2026-10-04 — The voice overlay never touches the mic, and a `?raw` CSS import read nothing

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #28 (S6-01), PR #154, issue #29 (S6-02), ADR-006, PRD FR-020 to FR-024, NFR-005

## What happened

The voice UI went in before any real transcription. An agent built the mic button, the recording overlay and a `Transcriber` interface with a `MockTranscriber`, in `apps/web/src/voice/`. #29 adds the real AudioWorklet and Transcribe Streaming code behind the same interface.

Nick settled the main question in the readiness review (r1/Q-1 (a)): the `Transcriber` owns mic permission and the audio stream, not the UI. The overlay therefore never calls `getUserMedia`, and its tests stub no browser API. The mock simulates denial, a missing mic, failures, levels and a transcript that never arrives, all set through its constructor.

`ChatPage` passes the mic as `Composer`'s `accessory` and hands it `chat.send`. A transcript then goes through the same blank and busy guards as typed text. The mic is disabled while the agent responds, like Send.

## Why we chose what we chose

The issue's assumptions A-1 to A-15 fixed most of the behaviour. The agent decided the rest:

- **`start()` resolving means recording has begun.** There is no separate "started" callback. The overlay starts its timer and the 60 s cap when the promise resolves. #29's A-6 holds audio chunks until the WebSocket opens, so `start()` can resolve as soon as capture starts. The alternative was an `onStarted` callback, which would have given two signals for the same moment.
- **`stop()` has no timeout of its own.** The overlay owns the 10 s wait (#29's A-8). When the wait runs out it calls `cancel()`, which must be safe to call at any time, more than once, and after `stop()` has settled. The interface header says so, because the overlay calls `cancel()` after every failure.
- **An attempt number, not `AbortSignal`s.** Each recording gets a number. A callback from an older attempt does nothing, except cancel a session it was handed. Examples are a `start()` that resolves after Cancel, a transcript that arrives after the timeout, or a level from the previous recording. An `AbortSignal` passed to `start()` would have meant more for #29 to wire, and it still couldn't take back a promise that had already resolved.
- **Errors after `start()` count as failures.** Any `onError`, whatever its kind, shows the FR-024 message in the overlay. Only a `start()` that rejects with `denied` or `unavailable` closes the overlay and shows the notice beside the composer. A rejection that isn't a `TranscriberError` counts as `failed`. The alternative was to send a `denied` `onError` (permission revoked mid-recording) to the notice beside the composer as well.
- **The level is a dot scaled by a CSS variable**, not an animation, so reduced motion loses only its easing. Until the Transcriber reports its first level, the dot pulses with a CSS animation instead, which the global reduced-motion rule stops. The agent first shipped the dot without the pulse. The review (04f8fc4/SPEC-3) found that the pulse fallback was in the r1/Q-1 recommendation Nick accepted, though not in the decision text applied to the issue, and Nick chose to add it: `onLevel` stays optional, so #29 doesn't have to report levels. The alternatives were to make `onLevel` required for every Transcriber, or to keep a static dot.
- **Focus goes to the first button of each phase.** That's Send in "Recording", Cancel in "Transcribing…", and Record again after an error. A button that disappears can't strand focus on `<body>`. The dialog has `tabIndex={-1}`, so a click on its background keeps focus inside it, and a press on the backdrop around the dialog is prevented, so focus stays where it was (the review's 04f8fc4/SPEC-1 found that a backdrop click left focus on `<body>`, where Esc and the trap no longer worked). The alternative was to focus the dialog itself on each phase change.
- **"Send recording" is an `aria-label` on a button that shows "Send"**, so the visible word is part of the accessible name. The alternative was a visible "Send recording" label.
- **Cancel stays in every phase,** next to Record again and Type instead after an error, because A-11 says Cancel works everywhere. The alternative was to drop Cancel in the phases where Type instead also closes the overlay.
- **The denied notice stays after its Type instead.** Its "Type instead" only focuses the message box; the next mic tap clears the notice. The alternative was to clear it on Type instead.
- **Wording.** The FR-024 message is "Sorry, we couldn't turn that into text.", the unsent state says "Your message wasn't sent. Try Send again in a moment.", and the production note is "Voice input isn't available yet." The spec gave no wording, and the agent didn't weigh other phrasings.
- **Dev mock timings.** On the dev server the mock shows "Starting…" for 0.3 s, then "hears" the sample sentence 1 s after Send (`DEV_MOCK_OPTIONS`). A-13 asked for "about a second" before the transcript. The alternative was no start delay, which would skip the "Starting…" state on the dev server.
- **The production build drops the mock without a dynamic `import()`.** `defaultTranscriber()` is `import.meta.env.DEV ? new MockTranscriber(...) : null`, and Vite removes the dead branch. A hand check of the production build found none of the mock's strings. `build.test.ts` belongs to #29, so no test checks this yet.

## What surprised us

The issue asked for a `?raw` text test, like `tokens.test.ts`, to check that `.visually-hidden` moved from `chat.css` to `global.css`. In Vitest, `import globalCss from "./global.css?raw"` returned an empty string. `vite.config.ts` lets Vitest process only `tokens.css` (`css: { include: [/tokens\.css/] }`), and every other CSS import comes back empty, `?raw` included. So the half that checks "`chat.css` no longer has the rule" would have passed without reading anything. The test reads both files with `readFileSync` instead, and it first checks that `chat.css` still has its own `.chat` rule, so an empty read fails.

Every test passed on its first run, and breaking the code showed which of them meant something. Of the first 105 breaks, four left the tests green. In jsdom, the focus trap's `preventDefault()` made no visible difference. Neither did the mic's unconditional `aria-describedby`, nor a cast that treated every rejection as a `TranscriberError`. The tests now check `fireEvent`'s return value, that the attribute is absent, and a plain `Error` rejection.

Four guards never went red, because another guard always covered them: the 10 s timer's own attempt check, Esc's `preventDefault()`, a second `discard()` after a denied `start()`, and a state check in the mock's failure timer. We removed them rather than keep code no test could defend.

## Evidence

- `npm run lint && npm run typecheck && npm test`, after the review fixes: 89 test files passed and 3 skipped; 1799 tests passed and 110 skipped, in each of three full runs with the output saved. The PR's own test files (`src/voice/`, `global.test.ts`, `ChatPage.voice.test.tsx`) also passed 10 runs in a row. Before the review, one of three full runs had reported 1 failed test whose name scrolled past; it didn't recur in the three full or 10 targeted runs after the fixes, so we couldn't name it. The skipped tests are the suites that need DynamoDB Local (`DYNAMODB_ENDPOINT`), plus the ADR-history check, which skips locally without its base ref.
- 105 breaks, scripted as exact string edits to `useRecording.ts`, `RecordingOverlay.tsx`, `VoiceInput.tsx`, `TranscriberContext.ts`, `transcriber.ts`, `MockTranscriber.ts`, `ChatPage.tsx`, `global.css` and `chat.css`. At `c6c4b90`, all 105 turn a test red. They include `>=` → `>` on the 60 s cap, an elapsed time counted from ticks instead of read from the clock, a timer started on the tap, and a dropped attempt check on each callback. Each is listed in the PR.
- The review of `04f8fc4` led to 36 more breaks, among them the 10 s wait set to 5 s and 15 s, `clearInterval` deleted from `discard()`, the context default replaced with `null` and with an always-on mock, the spinner deleted or shown in other phases, the backdrop's `preventDefault()` removed, and the pulse class, its `infinite` and the reduced-motion rule each removed. 35 turn a test red. The one that doesn't sets the hook's initial level to `0`; `record()` resets it to `null` before any recording renders, so the initial value can't be seen.
- Production build check (by hand): `vite build`, then grep the output for the sample transcript and the mock's option names: no match. The mic's label and the "isn't available yet" note are in the bundle.

## What's next

- #29 implements `Transcriber` and swaps `defaultTranscriber()` for its real-or-mock factory in `src/voice/`, and adds a `build.test.ts` check if it wants one.
- #36 tries the overlay on real browsers, and #40 adds the manual pass on iOS Safari and Android Chrome.
