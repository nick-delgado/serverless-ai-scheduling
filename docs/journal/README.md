# Development journal

A dated, first-person log of how this project was built: the decisions, the surprises, the dead ends, and the evidence. The narrative `README.md` is assembled from these entries, so write them as if a curious engineer will read them later. One will.

- **File name:** `YYYY-MM-DD-short-slug.md`. More than one entry per day is fine.
- **Voice:** "we" means Nick and the AI agents working with him. Be honest about what the agents did and what Nick decided.
- **Template and guidance:** the `dev-journal` skill (`.claude/skills/dev-journal/SKILL.md`).

## Entries

| Date | Entry | Chapter |
|---|---|---|
| 2026-09-28 | [Why this project, and planning before building](2026-09-28-why-this-project.md) | 1. The question |
| 2026-09-28 | ["ACTIVE" in the model catalog doesn't mean you can call it](2026-09-28-active-is-not-callable.md) | 3. The walking skeleton |
| 2026-09-29 | [Least privilege meets a real deploy](2026-09-29-least-privilege-meets-reality.md) | 3. The walking skeleton |
| 2026-09-29 | [A double-booking test only counts once you've watched it fail](2026-09-29-watch-the-double-booking-test-fail.md) | 3. The walking skeleton |
| 2026-09-29 | [The agent loop never learns whose data it touches](2026-09-29-the-loop-never-sees-the-patient.md) | 4. Teaching the agent to schedule |
| 2026-09-29 | [The reply streams through CloudFront untouched: first token in about 1 s, 15 ms of overhead](2026-09-29-streaming-survives-cloudfront.md) | 3. The walking skeleton |
| 2026-09-29 | [DynamoDB Local is too polite to test our retry path](2026-09-29-dynamodb-local-is-too-polite.md) | 4. Teaching the agent to schedule |
| 2026-09-29 | [Writing the evals first exposed gaps in the fixture and the harness](2026-09-29-writing-the-tests-before-the-agent.md) | 4. Teaching the agent to schedule |
| 2026-09-29 | [Denied the models we planned for, we made the agent speak to any model Bedrock serves](2026-09-29-one-transport-many-models.md) | 4. Teaching the agent to schedule |
| 2026-09-29 | [The first live eval run found a model inventing slots, and a blind spot in our own L1 grader](2026-09-29-first-live-l1-run.md) | 4. Teaching the agent to schedule |
| 2026-09-30 | [A past date gets an error, not an empty list, so the agent can't call last Friday "fully booked"](2026-09-30-a-past-date-is-an-error-not-an-empty-list.md) | 4. Teaching the agent to schedule |
| 2026-10-01 | [A retried booking must find the appointment it already made, even after the slot starts](2026-10-01-a-retry-must-find-the-booking-it-made.md) | 4. Teaching the agent to schedule |
| 2026-10-01 | [A reschedule moves the same visit: same specialty, and no back door to a closed panel](2026-10-01-a-reschedule-keeps-the-kind-of-visit.md) | 4. Teaching the agent to schedule |
| 2026-10-02 | [Every write tool now answers a repeat with success, and escalation stops promising an email](2026-10-02-every-write-tool-answers-a-repeat-with-success.md) | 4. Teaching the agent to schedule |
| 2026-10-02 | [The patient ID is a `sub` Cognito picks, so seeding users comes before seeding profiles](2026-10-02-the-patient-id-is-a-sub-cognito-picks.md) | 4. Teaching the agent to schedule |
| 2026-10-02 | [The mock API waits like the real one: no response headers until the first event](2026-10-02-the-mock-api-waits-like-the-real-one.md) | 4. Teaching the agent to schedule |
| 2026-10-02 | [The first real Cognito sub wasn't a UUID, and every live chat turn was a 401](2026-10-02-the-first-real-sub-was-not-a-uuid.md) | 4. Teaching the agent to schedule |
| 2026-10-02 | [System prompt v1: Sonnet goes to 66 of 66, and Nova Pro shows what a prompt can't fix](2026-10-02-system-prompt-v1.md) | 4. Teaching the agent to schedule |
| 2026-10-02 | [A timing test measured the reader, not the mock](2026-10-02-a-timing-test-measured-the-reader.md) | 4. Teaching the agent to schedule |
| 2026-10-02 | [The simulated patient says yes like a person, and our grader calls it a safety violation](2026-10-02-the-simulated-patient-says-yes-like-a-person.md) | 4. Teaching the agent to schedule |
| 2026-10-03 | [A re-seed must not undo what the agent booked, so the data seed only adds what's missing](2026-10-03-a-reseed-must-not-undo-the-agent.md) | 4. Teaching the agent to schedule |
| 2026-10-03 | [Restore shows what the patient saw: one bubble per turn, and no tool blocks](2026-10-03-restore-shows-what-the-patient-saw.md) | 4. Teaching the agent to schedule |
| 2026-10-03 | [One long act() hid every partial render, so the live-region test couldn't fail](2026-10-03-one-long-act-hid-every-partial-render.md) | 4. Teaching the agent to schedule |
| 2026-10-03 | [The Cognito mock does real SRP, because SRP never sends the password](2026-10-03-the-cognito-mock-does-real-srp.md) | 4. Teaching the agent to schedule |
| 2026-10-03 | [No decision was reversed, but 98 details had drifted into review comments](2026-10-03-the-drift-was-in-the-comments.md) | 4. Teaching the agent to schedule |
| 2026-10-04 | [The scroll test ran out of findByText's second, not the scroll](2026-10-04-the-scroll-test-ran-out-of-findbytext.md) | 4. Teaching the agent to schedule |
| 2026-10-04 | [The deploy script has tests too, and deleting a line missed half a guard](2026-10-04-the-deploy-script-has-tests-too.md) | 4. Teaching the agent to schedule |
| 2026-10-04 | [The staff email's address stays out of the repo, the logs and its own error messages](2026-10-04-the-staff-email-must-not-carry-its-own-address.md) | 4. Teaching the agent to schedule |
| 2026-10-04 | [Only the browser knows when a sign-in began, so the restore rule lives in the SPA](2026-10-04-only-the-browser-knows-when-a-sign-in-began.md) | 4. Teaching the agent to schedule |
| 2026-10-04 | [Deep links: the edge rewrites only what has no file extension, and never `/api`](2026-10-04-deep-links-rewrite-only-what-has-no-extension.md) | 4. Teaching the agent to schedule |
| 2026-10-04 | [A Retry re-runs a turn no tool touched, and replays one that a tool did](2026-10-04-a-retry-reruns-a-turn-no-tool-touched.md) | 4. Teaching the agent to schedule |
| 2026-10-04 | [The voice overlay never touches the mic, and a `?raw` CSS import read nothing](2026-10-04-the-overlay-never-touches-the-mic.md) | 4. Teaching the agent to schedule |
| 2026-10-04 | [CI now fails a line no test ran, including the right operand of `??`](2026-10-04-ci-now-fails-a-line-no-test-ran.md) | 4. Teaching the agent to schedule |
| 2026-10-05 | [Readiness reviews halved the open questions, and wrote some of the next mistakes](2026-10-05-readiness-reviews-halved-the-open-questions.md) | 4. Teaching the agent to schedule |
| 2026-10-05 | [A cut stream and a bare 5xx now offer Retry, and a buffered body without `done` is unreadable, not cut](2026-10-05-a-cut-stream-now-offers-retry.md) | 4. Teaching the agent to schedule |
| 2026-10-05 | [What the prompt couldn't stop, code now removes: `<thinking>` anywhere, and IDs in escalation summaries](2026-10-05-guards-outside-the-prompt.md) | 5. What the evals showed |
| 2026-10-05 | [The LLM judge scores beside the trial, never inside it](2026-10-05-the-judge-scores-beside-the-trial.md) | 4. Teaching the agent to schedule |
| 2026-10-05 | [Stryker finds breaks nobody listed, once patched for Vitest 5; an edit list re-checks only what it lists](2026-10-05-mutation-tools-find-what-nobody-wrote-down.md) | 4. Teaching the agent to schedule |
| 2026-10-05 | [Of three safety violations, one was real, and it came from a tool that couldn't answer](2026-10-05-one-real-safety-violation-in-three.md) | 5. What the evals showed |
| 2026-10-05 | [Another patient's ID inside your own appointment note is not a leak, but repeating it still is](2026-10-05-an-id-in-your-own-note-is-not-a-leak.md) | 5. What the evals showed |
| 2026-10-05 | [A new conversation is named before the agent runs, so a first turn's Retry continues it](2026-10-05-name-the-conversation-before-the-agent-runs.md) | 4. Teaching the agent to schedule |
| 2026-10-05 | [The copies had already drifted: one Bedrock error meant "busy" to a patient and a hard failure to the evals](2026-10-05-one-copy-of-the-model-call-plumbing.md) | 4. Teaching the agent to schedule |
| 2026-10-05 | [Five slots a day stopped hiding the rest: check_availability takes a start time](2026-10-05-a-floor-reaches-the-sixth-slot.md) | 5. What the evals showed |
| 2026-10-05 | [A refusal that quotes a time is not an offer: four false positives out of the safety gate](2026-10-05-a-refusal-that-quotes-a-time-is-not-an-offer.md) | 4. Teaching the agent to schedule |
| 2026-10-06 | [A clone detector finds 2 of 17 reviewed duplications, so it reports and doesn't block](2026-10-06-a-clone-detector-finds-2-of-17-duplications.md) | 4. Teaching the agent to schedule |
| 2026-10-06 | [One HH:MM schema, and an acceptance grep that would have passed with nothing moved](2026-10-06-one-hhmm-and-a-grep-that-found-nothing.md) | 4. Teaching the agent to schedule |
| 2026-10-06 | [An echoed floor is not a sixth option: max_five_options counts list lines](2026-10-06-an-echoed-floor-is-not-a-sixth-option.md) | 5. What the evals showed |
| 2026-10-06 | [No dated time before a tool returns it, and five options after several searches](2026-10-06-no-time-before-the-tool-returns-it.md) | 5. What the evals showed |
| 2026-10-06 | [Six "noticed" minors from the judge's PR, tidied, and a hash that pins the judge's prompt to its version](2026-10-06-six-noticed-minors-tidied.md) | 5. What the evals showed |
| 2026-10-06 | [Three reviews asked for the same journal fix, so a test checks it now](2026-10-06-the-journal-index-checks-itself.md) | 4. Teaching the agent to schedule |
| 2026-10-06 | [Eval results now outlive the worktree that ran them](2026-10-06-eval-results-outlive-the-worktree.md) | 5. What the evals showed |
| 2026-10-06 | [A same-slot reschedule retry is now the repository's success, not the handler's workaround](2026-10-06-a-retry-is-the-repositorys-answer-too.md) | 4. Teaching the agent to schedule |
| 2026-10-06 | [Ten cases the tool PRs asked for land as L1, and the API-surface case retires to the handler's tests](2026-10-06-tool-pr-cases-land-as-l1.md) | 4. Teaching the agent to schedule |
| 2026-10-06 | [One diff helper for two PR checks, and a path limit that only a moved file can see](2026-10-06-one-diff-helper-for-two-checks.md) | 4. Teaching the agent to schedule |
| 2026-10-06 | [The web tests wait by hops, not seconds, and the last flake under load is a closed socket](2026-10-06-the-web-tests-wait-by-hops-not-seconds.md) | 4. Teaching the agent to schedule |
| 2026-10-07 | [The prompt and the tools now read the clinic calendar from one place, and two of its mutations only fail outside UTC](2026-10-07-one-copy-of-the-clinic-calendar.md) | 4. Teaching the agent to schedule |
| 2026-10-07 | [The patient simulator keeps its own default, and a bad simulator setting only breaks the runs that use it](2026-10-07-the-simulator-keeps-its-own-default.md) | 4. Teaching the agent to schedule |
| 2026-10-07 | [Three rules that lived in two or three places now live in one](2026-10-07-three-rules-each-written-once.md) | 4. Teaching the agent to schedule |
| 2026-10-07 | [A reschedule that loses the race to its identical twin now answers already_rescheduled, and on DynamoDB Local it fails all three conditions](2026-10-07-the-losing-twin-move-is-a-retry-too.md) | 4. Teaching the agent to schedule |
| 2026-10-07 | [The scroll test's closed socket was a connection MSW handed to the real network](2026-10-07-the-closed-socket-was-a-passthrough.md) | 4. Teaching the agent to schedule |
| 2026-10-08 | [An owner decision now wins over an agent's own reading, and a lint holds write confirmations to the full date](2026-10-08-owner-decisions-win-over-an-agents-reading.md) | 5. What the evals showed |
| 2026-10-08 | [The date tests now run in Los Angeles, because UTC and the clinic's zone each hid a date bug we knew of](2026-10-08-the-date-tests-run-in-los-angeles.md) | 4. Teaching the agent to schedule |
| 2026-10-08 | [Browser voice passes on four browsers, but ending the SDK's audio stream the obvious way loses the transcript](2026-10-08-voice-streams-pass-but-the-sdk-hangs-up-early.md) | 4. Teaching the agent to schedule |
