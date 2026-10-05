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
