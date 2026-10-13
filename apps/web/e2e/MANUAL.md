# Manual device and voice pass (#40)

The part of NFR-006 and FR-020–FR-024 that Playwright doesn't cover: text chat on real phones, and the voice path, which has no automated test. Nick runs it before #40's PR merges, on `e2e`, as the E2E patient, and the agent copies the results into the PR's table (r1/Q-7 (a)).

## Before you start

1. **Reseed `e2e`**, so Sofia starts from the fixture (runbook, "Appendix: end-to-end tests (the e2e env)", the local commands up to `seed-data.ts --reset`). Don't run the automated suite or `e2e.yml` during the pass: their reseed deletes your bookings mid-pass.
2. **The URL:** `https://<domain>/`, with the domain from `aws ssm get-parameter --profile sched-dev --name /sched/e2e/web/domain --query Parameter.Value --output text`.
3. **Sign in** as `sofia.marquez`, with `DEMO_PASSWORD_SOFIA` from the main checkout's `.env`.
4. **Each phone books a different provider who takes new patients and isn't Sofia's:** Dr. Priya Lee on the iPhone, Dr. Samuel Okafor on the Android phone, so neither repeats the other's booking. Note the device, OS version, browser version and date for each row of the results table.

Every turn costs a few cents of Bedrock time (about $0.01 a turn). A full pass is well under $1.

## Part A: text chat, login → book (iOS Safari, Android Chrome)

| # | Step | Expected |
|---|---|---|
| A1 | Open the URL signed out. | The sign-in page. Opening `/chat` also lands here. |
| A2 | Sign in with the phone's keyboard, submitting with its Go/Enter key. | The chat opens with a greeting that names Sofia. |
| A3 | Type "I'd like to book a skin check with Dr. <provider> on <a weekday this week or next>." | A typing indicator, then status chips ("Looking up providers…", "Checking availability…"), then a reply listing times. The page scrolls to keep the reply in view. |
| A4 | Type "The earliest of those works for me." | The assistant confirms the time and asks before booking. Nothing is booked yet. |
| A5 | Type "Yes, please book it." | "Booking your appointment…" shows, then a confirmation with the date and time. |
| A6 | Rotate the phone, then reload the page. | Still signed in; the conversation comes back (FR-014). |
| A7 | Tap **Sign out**. | Back on the sign-in page. |

## Part B: voice (Chrome desktop, Safari macOS, iOS Safari, Android Chrome; Firefox and Edge best effort)

Sign in first. The mic button ("Record a voice message") is next to Send.

| # | Step | Expected | How to bring it about |
|---|---|---|---|
| B1 | Tap the mic for the first time. | The browser asks for the microphone. If you deny it, an inline message says how to enable it and that typing still works (FR-020). | Use a fresh site permission (clear it in the browser's site settings first). Allow it after checking the denied message. |
| B2 | Record "Is Dr. Omar Haddad free next week?", then **Send**. | The overlay shows a running m:ss timer and a level indicator while recording, then "Transcribing…", then your words appear as your chat bubble and go to the agent like typed text (FR-021–FR-023). | Speak normally. |
| B3 | **Mic disabled while the agent responds.** Right after B2's transcript is sent, try the mic button. | It's disabled until the reply has finished, like Send (FR-020). | Tap it while the typing indicator or a status chip shows. |
| B4 | **60 s auto-send.** Start recording and say a sentence, then stay silent. | At 1:00 the recording stops and is sent as if you pressed Send (FR-021). | Wait for the timer to reach 1:00 without pressing anything. |
| B5 | **No final transcript within 10 s of Send (FR-022, FR-024).** Record a sentence, press **Send**, and cut the network at once. | Within about 10 s of Send: "Sorry, we couldn't turn that into text." (or "Your message wasn't sent. Try Send again in a moment."), with **Record again** and **Type instead**. Both work once the network is back. Nothing is sent to the agent. | Desktop: DevTools → Network → Offline right after Send (Safari: Develop → Network conditions, if available). Phones: airplane mode right after Send. If the error appears well before 10 s, note "connection error, not the timeout"; if the device can't be taken offline fast enough, mark the step **not induced** with the reason. It counts as neither a pass nor a fail (r1/Q-7 edges). |
| B6 | Record silence (or cover the mic), then **Send**. | "I didn't catch that." and nothing sent (FR-023). | Stay silent for 3–4 s. |
| B7 | Start recording, then press **Esc** (desktop) or **Cancel**. | The overlay closes and nothing is sent (FR-021). | |

## Results

Copy this table into the PR (one row per device and browser). Use `pass`, `fail` (with a note), `not induced` (with the reason) or `n/a`.

| Device | OS | Browser (version) | Date | A1–A7 | B1 | B2 | B3 | B4 | B5 | B6 | B7 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| iPhone | iOS | Safari | | | | | | | | | | |
| Android phone | Android | Chrome | | | | | | | | | | |
| Desktop | macOS | Chrome | | n/a | | | | | | | | |
| Desktop | macOS | Safari | | n/a | | | | | | | | |
| Desktop | | Firefox (best effort) | | n/a | | | | | | | | |
| Desktop | | Edge (best effort) | | n/a | | | | | | | | |
