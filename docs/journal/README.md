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
| 2026-10-08 | [Three CI roles that each trust one workflow file, and a probe that checked their subjects first](2026-10-08-three-ci-roles-trust-one-workflow-each.md) | 5. What the evals showed |
| 2026-10-08 | [Browser voice passes on four browsers, but ending the SDK's audio stream the obvious way loses the transcript](2026-10-08-voice-streams-pass-but-the-sdk-hangs-up-early.md) | 4. Teaching the agent to schedule |
| 2026-10-09 | [AWS declined Opus 5, Sonnet 5 and the quota increases, so six profiles at 10 RPM are the plan, not a stopgap](2026-10-09-aws-declined-opus-5-and-the-quota-increases.md) | 5. What the evals showed |
| 2026-10-09 | [The eval gate compares cases, not counts, and our cost estimate was 7x high](2026-10-09-the-eval-gate-and-an-estimate-that-was-7x-high.md) | 5. What the evals showed |
| 2026-10-09 | [The mic streams for real, and a build flag carries the stopwatch to the phones](2026-10-09-the-real-transcriber.md) | 4. Teaching the agent to schedule |
| 2026-10-10 | [The deployed chat runs the real prompt, and the escalation alarm fires end to end](2026-10-10-the-deployed-chat-runs-the-real-prompt.md) | 5. What the evals showed |
| 2026-10-10 | ["This is Maria" now gets one question first, and the old prompt already refused](2026-10-10-ask-who-is-speaking-before-acting.md) | 5. What the evals showed |
| 2026-10-11 | [The chat bubble shows plain text, so the prompt now asks for it, and two checks hold it there](2026-10-11-plain-text-for-a-plain-text-bubble.md) | 5. What the evals showed |
| 2026-10-11 | [A mutation suggester reads the code, and its first target was itself](2026-10-11-the-suggester-broke-its-own-code-first.md) | 5. What the evals showed |
| 2026-10-13 | [What the evals showed: fourteen cells, one near-miss, and a latency target no effort level meets](2026-10-13-what-the-matrix-chose.md) | 5. What the evals showed |
| 2026-10-13 | [An empty pid file reads as pid 0, and `kill(0)` is the test run's own process group](2026-10-13-an-empty-pid-file-is-pid-zero.md) | 5. What the evals showed |
| 2026-10-13 | [Five tests sliced YAML five ways; one reader now decides where a block ends](2026-10-13-one-reader-for-yaml-as-text.md) | 5. What the evals showed |
| 2026-10-13 | [The deploy scripts' tests run on an allow-listed PATH, so a missing stand-in can't reach AWS](2026-10-13-the-shell-scripts-run-on-an-allow-list.md) | 5. What the evals showed |
| 2026-10-13 | [The trace viewer prints figures, not words, and can't read the messages next to the traces](2026-10-13-the-trace-viewer-reads-figures-not-words.md) | 5. What the evals showed |
| 2026-10-13 | [The E2E suite reads the stream, not the reply, and the agent asked again even when told yes](2026-10-13-the-e2e-suite-reads-the-stream-not-the-reply.md) | 5. What the evals showed |
| 2026-10-14 | [The dashboard reads the turn's log line, and Powertools' wrappers can't see a streaming handler's context](2026-10-14-the-dashboard-reads-the-log-line.md) | 5. What the evals showed |
| 2026-10-15 | [A split issue nearly closed early, so the PR body gets a check of its own](2026-10-15-the-pr-body-gets-a-check-of-its-own.md) | 5. What the evals showed |
| 2026-10-15 | [An empty process group isn't an error, and Vitest won't fail a test for a throw in a timer](2026-10-15-an-empty-process-group-is-not-an-error.md) | 5. What the evals showed |
| 2026-10-15 | [deploy.sh reads .env the way Node does, and both scripts refuse what they used to guess at](2026-10-15-deploy-reads-env-the-way-node-does.md) | 5. What the evals showed |
| 2026-10-15 | [A timed-out mutate run stops reading the output instead of waiting for a process it can't kill](2026-10-15-a-timeout-stops-reading-the-output.md) | 5. What the evals showed |
| 2026-10-15 | [The security review's burst never reached the throttle: Lambda's concurrency quota of 10 answered first](2026-10-15-the-throttle-never-saw-the-burst.md) | 5. What the evals showed |
| 2026-10-15 | [A quoted slot is an offer, not an echo: the slot check reads heading lists and lets three non-offers go](2026-10-15-a-quoted-slot-is-an-offer-not-an-echo.md) | 5. What the evals showed |
| 2026-10-15 | [Five options, grouped by day: one search per weekday spreads a broad request](2026-10-15-five-options-grouped-by-day.md) | 5. What the evals showed |
| 2026-10-15 | [A timed-out unedited run is no baseline, even when it exits 0](2026-10-15-a-timed-out-unedited-run-is-no-baseline.md) | 5. What the evals showed |
| 2026-10-16 | [A new env from the runbook alone: five friction points, then 7 min 45 s from deploy to a signed-in turn](2026-10-16-a-new-env-from-the-runbook-alone.md) | 5. What the evals showed |
| 2026-10-16 | [Every expected test goes red: batch 11 closes four gaps the suggester and the PR body left open](2026-10-16-every-expected-test-goes-red.md) | 5. What the evals showed |
| 2026-10-16 | [A second quick body edit now waits its turn instead of cancelling the first one's run](2026-10-16-a-second-body-edit-waits-its-turn.md) | 5. What the evals showed |
| 2026-10-16 | [A format miss is not a leak: L1 gets non-safety text checks, and a lint keeps them apart](2026-10-16-a-format-miss-is-not-a-leak.md) | 5. What the evals showed |
| 2026-10-16 | [The handoff rule we tightened already held, and the two-request case now fails on "ET", not on questions](2026-10-16-the-handoff-rule-already-held.md) | 5. What the evals showed |
| 2026-10-16 | [Five chat turns at once per env: the reservation turns the sixth into a 500 the SPA already retries](2026-10-16-five-chat-turns-at-once.md) | 5. What the evals showed |
| 2026-10-16 | [The judge agrees with Nick on 42 of 49 calls, and passes every reply he failed](2026-10-16-the-judge-agrees-but-passes-every-reply-nick-failed.md) | 5. What the evals showed |
| 2026-10-16 | [A prompt bump now stays in `prompts/`: the tests outside it ask the factory for the version](2026-10-16-a-prompt-bump-stays-in-prompts.md) | 5. What the evals showed |
| 2026-10-16 | [A lead-in that ends with the date is not a day line: three offer cases now want the day alone on its line](2026-10-16-a-lead-in-that-ends-with-the-date-is-not-a-day-line.md) | 5. What the evals showed |
| 2026-10-16 | [Eval gate jobs from different PRs now wait in one queue instead of sharing the Bedrock quota](2026-10-16-eval-gate-jobs-wait-in-one-queue.md) | 5. What the evals showed |
| 2026-10-16 | [The derm case's Monday bookings were the patient's idea: our scenario told it to want "sooner"](2026-10-16-the-patient-asked-for-the-monday.md) | 5. What the evals showed |
| 2026-10-16 | [The agent restated 1:00 PM and booked 12:00 PM: the booking tools now check what the patient said yes to](2026-10-16-the-tools-check-what-the-patient-confirmed.md) | 5. What the evals showed |
| 2026-10-16 | [The lead-in needed a place for the day: "that day" took `l1-offer-single-day` from 2 of 5 to 10 of 10](2026-10-16-the-lead-in-says-that-day.md) | 5. What the evals showed |
| 2026-10-17 | [A cut Bedrock stream ends exactly like a finished one, so the client now checks for the last two events](2026-10-17-a-cut-stream-ends-like-a-finished-one.md) | 5. What the evals showed |
| 2026-10-17 | [Options go inside the one question: `system.v8` passes `clarify-vague-request`'s question checks 5 of 5, and two of five opening replies joined two details with "and"](2026-10-17-options-go-inside-the-one-question.md) | 5. What the evals showed |
| 2026-10-17 | [Times outside an offer list: `system.v9` passes the two-request case 3 of 3, and every undated time it wrote still left out "ET"](2026-10-17-every-undated-time-still-left-out-et.md) | 5. What the evals showed |
| 2026-10-17 | [The time check now reads every clock time: 7 of the 20 recorded trials fail it, and so does every undated time in #293's runs](2026-10-17-the-time-check-reads-every-clock-time.md) | 5. What the evals showed |
| 2026-10-18 | [`system.v10` puts ET on every undated time: the four smoke cases fell from 5 of 24 failing trials to 1 of 12, and one lead-in still leaves out the weekday](2026-10-18-undated-times-now-carry-et-the-weekday-is-what-is-left.md) | 5. What the evals showed |
| 2026-10-18 | [`judge.v2` fails one of the six replies Nick scored 3 on clarity, and scores the 911 reply 5: agreement 44/49 on the set it was fitted to](2026-10-18-the-judge-now-fails-one-of-nicks-six-clarity-3s.md) | 5. What the evals showed |
| 2026-10-18 | [`system.v11` keeps a time out of a several-day lead-in: the lead-in misses went from 3 trials in #321's run 4 to none in run 2, and two other sentences took their place](2026-10-18-several-day-offers-name-no-time.md) | 5. What the evals showed |
| 2026-10-18 | [`clarify-unsupported-specialty` stops demanding `find_providers`: a correct "we don't offer that" from the prompt's list now passes](2026-10-18-an-answer-from-the-prompt-is-a-correct-answer.md) | 5. What the evals showed |
| 2026-10-18 | ["Go ahead with that change" is a yes: the explicit-yes check stops flagging the one phrase #326's run 2 produced](2026-10-18-go-ahead-with-that-change-is-a-yes.md) | 5. What the evals showed |
| 2026-10-18 | [A pre-tool line needs ET, not a weekday: regraded offline, the four runs' failing trials fall from 11 of 60 to 6](2026-10-18-a-pre-tool-line-needs-et-not-a-weekday.md) | 5. What the evals showed |
| 2026-10-18 | [A specific time over several days is searched per weekday, and a line before that search may name the time with ET: the time check fails 0 of 15 trials in the measured run](2026-10-18-one-time-over-several-days-is-searched-per-weekday.md) | 5. What the evals showed |
| 2026-10-19 | [A spoken message reaches the model with a marker line, and everything else about it stays as it was](2026-10-19-a-spoken-message-carries-a-marker-and-nothing-else-changes.md) | 5. What the evals showed |
| 2026-10-19 | [The grader reads "every day next week" and "on both days" as naming the days when day lines back them: PR #339's two gate failures pass](2026-10-19-backed-several-day-leadins-in-more-wordings.md) | 5. What the evals showed |
| 2026-10-19 | [Seven suggested eval cases, and the pre-tool checks L1 can't make](2026-10-19-seven-suggested-cases-and-the-checks-l1-cannot-make.md) | 5. What the evals showed |
| 2026-10-19 | [On replies from `system.v13`, `judge.v2` agrees with Nick on 47 of 47 pass/fail calls, and Nick scored none of them below 4](2026-10-19-judge-v2-agrees-with-nick-on-47-of-47-on-system-v13-replies.md) | 5. What the evals showed |
| 2026-10-19 | [The boundary keeps only what a workload role grants, and the exec-role narrowing waits for a second PR](2026-10-19-the-boundary-keeps-only-what-a-workload-role-grants.md) | 5. What the evals showed |
