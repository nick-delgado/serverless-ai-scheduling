# 2026-10-22 — The demo script and the access doc promise no credential and no address

**Chapter:** 6. What I'd do next
**Milestone:** M4 (issue M4-02, first part)
**Related:** #44, PR #TBD, #357, #368, ADR-009, PRD FR-001

## What happened

#357 gave `demo` a request page: a reviewer asks for a temporary patient and gets a username, password and name once. #44 is the other half, the words that send a reviewer there. This first part (a task worker's PR, `Refs #44`) adds `docs/demo/script.md`, a six-beat walk (request and sign in, text booking, voice, reschedule, escalation, eval report), and `docs/demo/reviewer-access.md`. It also adds a short "See it working" section to the README and fixes the three lines #368 made false (a sentence in `docs/runbooks/deploy-env.md` and a `Later` pointer in each of two journal entries). The recording link reads "recording to come". Nick's timed dry run and the take come in the closing PR.

The worker wrote the script from the wording the e2e specs and the manual checklist already use, so a reviewer types what the suite types. It changed no source file.

## Why we chose what we chose

- **No address in the repo (r2/Q-2).** Nick put the `demo` sign-in address in the repository's About → Website field, and the README and the access doc say "the link in the About field". The alternative, printing the CloudFront address, would let anyone who reads the repo reach the request page and would put a second place to update when `demo`'s web stack is recreated, next to the Turnstile hostname. The page's own caps bound the spend either way; we chose the one place to change.
- **Page first, contact as the fallback (r2/Q-3).** The doc names no fixture account and no password. The alternative, sending a fixture patient when requests run out, would have meant naming usernames and warning that people sharing one see each other's bookings.
- **The eval beat quotes the committed table as is (r2/Q-4).** The beat reads ADR-002's 2026-10-20 amendment, "not met" rows included, with one sentence that #360 and #361 have since changed two graders. A fresh exit table would have cost at least $16.72 and a new issue; a reviewer can open the committed page.
- **One README section, not a rewrite (r2/Q-6).** The contact line stays at the top of the opening block, because the request page's cap message and the env-cap message both send people to it. The status line and the "coming in M…" placeholders stay for #43.
- **The voice beat asks about the booking.** The manual checklist's voice line asks about Dr. Haddad's week; the script asks "What appointments do I have coming up?" so the voice turn also shows the booking the text beat made, and the later reschedule has something to move. (Left open by the spec: the exact utterance; recorded here.)

## What surprised us

- **A doc that promises nothing is hard to write.** The limits (cap sizes, expiry, voice backstop) are `api` stack parameters that Nick can change. The access doc names the current expiry and the 50-message default as "at present" and links the runbook for the rest, so a parameter change doesn't make it false.

## Evidence

- The credential check from the issue, `git grep -nE 'user-[a-z0-9]{8}([^a-z0-9]|$)|DEMO_PASSWORD_[A-Z]+=[A-Za-z0-9]' -- docs/demo README.md`, prints nothing. It matches a line holding `user-k3j9x2ab` or `DEMO_PASSWORD_MARIA=Example1234x` and not `user-<8 characters>` (checked on scratch files).
- `git grep -n 'cloudfront.net' -- README.md docs/demo` prints nothing.
- No source file changed, so there is no mutation table, no coverage line and no eval run.

## What's next

- Nick's timed dry run of the script on `demo` as a fresh temporary patient, then the recording and its link in the closing PR (`Closes #44`), uploaded only after the take's account has been deleted.
- #43 rewrites the README's chapters and status line; the "See it working" section stays right after the opening block.
