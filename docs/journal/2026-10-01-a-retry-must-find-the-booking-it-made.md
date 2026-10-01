# 2026-10-01 — A retried booking must find the appointment it already made, even after the slot starts

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #21, PR #69, ADR-004 (idempotency), PRD FR-031, FR-035, NFR-008; review findings SPEC-1, SPEC-3 and SPEC-4 on PR #69

## What happened

The task-worker agent built `book_appointment` around the repository's atomic `appointments.book`, with a tool-level rule in front of it: a slot that has already started can't be booked. The review of PR #69 found that this rule ran before the idempotency check. ADR-004 says booking "first checks whether the patient already holds that slot", and issue #21 makes that an acceptance criterion. The repository's hold check only ran inside `appointments.book`, which a started slot never reached.

The review also surfaced two questions the spec didn't answer. Which error code does a started slot get? And can a new patient book Dr. Brooks, who isn't taking new patients? The agent had chosen `NOT_ALLOWED` for the first and done nothing about the second. Nick decided all three after the agent laid out the options.

## Why we chose what we chose

**The hold check comes first (SPEC-1).** The options were (a) return the held appointment even when it has started, or (b) keep the order and document an exception. The case that matters is a retry. A booking at 8:58 for a 9:00 slot succeeds, but the response is lost, and the retry arrives at 9:01. Under (b) the tool answers "that time has already passed", and the model tells the patient it couldn't book them while they actually hold the appointment. Nick chose (a). The hold is read through the patient-scoped `appointments.get`, so another patient's booking of the same slot reads as nothing, and they still get the past-slot error with no hint of who holds it.

**A started slot stays `NOT_ALLOWED` (SPEC-3).** The other candidates misled the model. `SLOT_UNAVAILABLE` means someone just took the slot, and its hint suggests nearby times that day. `INVALID_INPUT` suggests the model's arguments were malformed, when the slot id was valid and time simply passed. `NOT_ALLOWED` ("the request breaks a rule") is also what `reschedule_appointment` (#22) already uses for its started-time cases.

**"Not taking new patients" is enforced at booking (SPEC-4).** The options were to flag it, enforce it, or leave it to the model. Leaving it to the model means a weak model that skips `find_providers` books a new patient with Dr. Brooks, and staff have to undo it. Enforcing it fits Nick's earlier decision for `check_availability`: specialty searches leave such providers out, while searching by `provider_id` still shows their slots, because existing patients must still be able to book. A patient counts as existing when they have a COMPLETED or BOOKED appointment with that provider. In the fixture, Walter (a completed physical with Dr. Brooks) can book him, and James, a new patient, gets `NOT_ALLOWED` with a hint to offer another family doctor. The cost: a model that never checked learns the rule only at booking, after the patient has confirmed. The hint keeps that recoverable.

## What surprised us

All three answers came from what goes wrong when a call is repeated or when a weak model doesn't check, not from the happy path, which already worked. The ordering bug was invisible to the 18 tests in the PR. Each one tested a single rule, and none tested two rules meeting: a slot that is both held by the patient and already started.

## Evidence

- Rules and their order: header of `packages/tools/src/tools/book_appointment.ts`.
- Tests in `packages/tools/test/tools/book_appointment.test.ts`: "returns the slot the patient already holds even at its start / after its start (idempotency comes first)", "refuses a new patient for a provider not taking new patients, writing nothing", "books an existing patient with a provider not taking new patients".
- Mutation checks while fixing the review: skipping the hold check, dropping the new-patient rule, and counting only BOOKED history each fail exactly the test written for them.
- Review report and response: comments on PR #69.

## What's next

- `reschedule_appointment` (#22) lets a patient move to another provider. Its review should apply the same new-patient rule there.
- One shared "is this slot still bookable" check for `check_availability` and `book_appointment`, in the cleanup issue #77.
