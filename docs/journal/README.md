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
| 2026-10-02 | [A timing test measured the reader, not the mock](2026-10-02-a-timing-test-measured-the-reader.md) | 4. Teaching the agent to schedule |
