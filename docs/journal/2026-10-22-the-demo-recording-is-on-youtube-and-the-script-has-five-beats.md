# 2026-10-22 — The demo recording is an unlisted YouTube video and the script has five beats

**Chapter:** 6. What I'd do next
**Milestone:** M4 (issue M4-02, closing part)
**Related:** #44, PR #374, [the first part's entry](2026-10-22-the-demo-script-and-access-doc-promise-no-credential-and-no-url.md), #43

## What happened

The first part of #44 (PR #374) left two things for this one: Nick's timed dry run of `docs/demo/script.md` and the recording's link. Nick did the dry run on `demo` as a fresh temporary patient in desktop Chrome and posted it on the issue: about 5 min 10 s for five beats, all five passed (request and sign in, text booking, voice message, reschedule, escalation). That is just over the script's 3 to 5 minute target; Nick accepted the time as is, so the script keeps saying "about 3 to 5 minutes". The recording itself runs about 4 minutes, and the README line says so.

He then recorded the walk. GitHub refused the video as a comment attachment (r2/Q-5's size-limit edge), so the recording is an unlisted YouTube video and the README's recording line links it. A task worker (Claude) made the doc changes in this PR; the dry run and the recording are Nick's.

## Why we chose what we chose

- **An unlisted YouTube video, not a GitHub attachment (r2/Q-5, option (b)).** The attachment was the first choice because it keeps the video next to the repository, but GitHub would not take the file. The alternatives were a GIF (the issue's other option, which would have lost the voice beat's timing and sound) or a binary committed to the repo (ruled out by the issue's non-goals). The link is the one address this PR commits; the demo's own address stays only in the repository's About field (r2/Q-2).
- **Five beats, and the recording has no eval-report beat (r2/Q-4 as corrected).** The eval results go to the README in #43, where a reader gets them with the rest of the story, so the script drops its beat 6 and every mention of it. The first part's "The eval beat quotes the committed table as is" decision no longer applies; it was never run.
- **The README's walkthrough bullet goes; the access doc links the script (r2/Q-6 as corrected).** The recording line is the README's only pointer to the walk, and `docs/demo/reviewer-access.md` already points to `script.md` for a reviewer who wants to do it by hand.
- **The over-time dry run is accepted, not trimmed.** The beats' own estimates add to about 3 minutes 15 seconds; the 5 min 10 s includes the typing, waits for the model and reading each reply. The alternatives were changing the issue's target to "about 5 minutes" or trimming the walk (dropping the reschedule beat's closing "What appointments do I have?" check, or tighter narration); Nick kept the script and the target as they are, with the dry run ten seconds over.

## Evidence

- Nick's dry run: https://github.com/nick-delgado/serverless-ai-scheduling/issues/44#issuecomment-6347427792
- No source file changed, so there is no mutation table, no coverage line and no eval run.

## What's next

- #43 puts the eval results in the README's chapters; the "See it working" section stays right after the opening block.
