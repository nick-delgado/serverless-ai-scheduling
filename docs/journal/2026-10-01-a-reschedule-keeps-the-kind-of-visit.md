# 2026-10-01 — A reschedule moves the same visit: same specialty, and no back door to a closed panel

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #22, PR #67, PRD FR-032, NFR-008; review findings SPEC-1, SPEC-2 and STD-3 on PR #67; journal [2026-10-01 — A retried booking must find the appointment it already made](2026-10-01-a-retry-must-find-the-booking-it-made.md)

## What happened

The task-worker agent built `reschedule_appointment` around the repository's atomic `appointments.reschedule`. It allowed a move to any open slot, with any provider and in any specialty, on the grounds that the patient had confirmed the new time. The repository leaves that choice to the tool: "The new slot may be with another provider or specialty; whether that is allowed is a tool-level decision."

The review of PR #67 found two consequences. A patient could reach Dr. Brooks, who isn't taking new patients, by booking any open slot and then moving it into one of his. And a dermatology "Mole check" moved into a cardiology slot became a cardiology appointment for a mole check. The first had already been decided: the `book_appointment` entry's "What's next" asked this tool to apply the same new-patient rule. The second was open, and Nick decided it.

## Why we chose what we chose

**Moves stay within the appointment's specialty (SPEC-2).** The options were (a) same specialty only, answering `NOT_ALLOWED` with a hint to book a new appointment, or (b) any specialty, relying on confirm-before-write. Nick chose (a). PRD FR-032 describes moving *the same* appointment. A different kind of visit carries a different reason, and only `book_appointment` collects a reason. The cost is two steps for a patient who really wants a different kind of visit: book the new one, then deal with the old one.

**The closed-panel rule applies to the new provider (SPEC-1).** It is the rule from `book_appointment`: a provider who isn't accepting new patients can only take a patient who has a COMPLETED or BOOKED appointment with them. The appointment being moved counts, so a move between two of that provider's own slots still works. Within one specialty the rule still matters: Brooks and Alvarez are both family medicine, so Sofia (an Alvarez patient) gets `NOT_ALLOWED` for a Brooks slot, while Walter (a completed physical with Brooks) can move a family-medicine appointment to him.

**A retry is recognized before the clock rules (STD-3).** This is the same ordering bug the `book_appointment` review found, in a new tool. A move into a 9:00 slot succeeds at 8:58, the response is lost, and the retry arrives at 9:05. The appointment now sits in a slot that has started, so the "already started" check answered "can't be moved. Nothing was changed." The same-slot check now runs first, and its hint says the move already succeeded.

## What surprised us

The lesson from `book_appointment` didn't carry over by itself. Its journal entry said in plain words that this tool's review should apply the new-patient rule, and the first version of the tool still didn't. The retry-ordering bug came back the same way. The specialty rule then changed two existing tests, the taken-slot test and the concurrent-move race. Both had picked their slots across specialties only because those slots happened to be convenient in the fixture, so they now set up same-specialty appointments to keep testing what their names say.

## Evidence

- Rules and their order: header of `packages/tools/src/tools/reschedule_appointment.ts`.
- Tests in `packages/tools/test/tools/reschedule_appointment.test.ts`: "NOT_ALLOWED for a slot in another specialty", "NOT_ALLOWED for a new patient of a provider who isn't taking new patients", "allows an existing patient to move to a provider who isn't taking new patients", "a retry after the new time has started still says the move already succeeded".
- Mutation checks while fixing the review: removing the specialty check, the closed-panel check or the early same-slot check each fails exactly the test written for it. The file went from 23 to 30 tests.
- Review reports, Nick's decision and the responses: comments on PR #67.

## What's next

- A retried reschedule still answers `INVALID_INPUT` with an "already succeeded" hint rather than an idempotent success. Changing that needs an `already_rescheduled` output field and a repository change. It is left to Nick (PR #67 review SPEC-3).
