# 2026-10-02 — Every write tool now answers a repeat with success, and escalation stops promising an email

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #88, PR #67 review (1e91080/SPEC-3), PR #68 review (eb06740/SPEC-4), `add-agent-tool` skill

## What happened

The three tools that write had three different answers to "you already did this". `book_appointment` returned success with `already_booked: true`. `escalate_to_human` returned success with `already_escalated: true`. `reschedule_appointment` returned an `INVALID_INPUT` error, "The appointment is already at that time", with a hint that a retry meant the move had worked. The `add-agent-tool` skill said retries return success, so the skill and the code disagreed. The reviews of #67 and #68 left two questions for the owner, and both landed on #88.

Separately, the `escalate_to_human` description said the tool "emails staff your summary plus the transcript". But by Nick's earlier decision on #68 (SMELL-1), a failed email still returns the same success, so the patient always gets the phone number. The description promised something the tool doesn't check.

## Why we chose what we chose

**Reschedule retries (decision 1).** Nick chose a success with `already_rescheduled: true` over keeping the error. The deciding argument was the system prompt still to be written (#16): with one rule for all three tools ("`already_*: true` means it's done; confirm it, don't retry"), the prompt teaches no special case. Weaker models also tend to treat any error as a failure, apologise or escalate, and "invalid input" was the wrong label anyway, since nothing in the input was wrong. The cost is a contracts change: a new output field, and `previous_start_local` becomes `null` when nothing moved, because a retry can't know the time the appointment had before the first call.

**The escalation email (decision 2).** Nick chose to reword the description ("notifies staff with your summary and the transcript") over adding a `staff_notified` field. Failed sends are retried out of band (his #68 SPEC-3 decision), so staff do get the summary in the end, and the patient always gets the phone number. A field would have let the agent say "staff already have your summary". It was left as the option to revisit if evals catch the agent overclaiming.

## What surprised us

The handler already answered the retry before any clock rule, so the obvious change was that one line. But the repository has its own `SAME_SLOT`, which a concurrent retry hits when two calls read the appointment before either moves it. Changing only the pre-check would have left that path returning the old error. Both paths now go through one helper, and a parallel-duplicates test and a stubbed-race test pin them.

## Evidence

- `packages/tools/src/tools/reschedule_appointment.ts` header, step 2; tests "answers already_rescheduled for the slot it already holds", "a retry after the new time has started still answers already_rescheduled", "parallel duplicate moves by the same patient", and "answers already_rescheduled when the repository reports SAME_SLOT".
- Mutation checks: restoring the error in the pre-check, removing the pre-check, answering the repository's `SAME_SLOT` as an error, marking a real move as `already_rescheduled`, and keeping a previous time on a retry each fail their tests.
- The before/after eval run is in PR #88's description.

## What's next

- #16 (system prompt) states one retry rule for all three write tools.
