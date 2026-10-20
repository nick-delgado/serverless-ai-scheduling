# 2026-10-19 — The patient's time of day stays on every search until they change it in words

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #306, PR #355, #301, ADR-008, PRD FR-030, #293, #332, #234, #251

## What happened

#301's runs of `book-derm-next-week-afternoon` showed a miss that wasn't what failed the case. The patient had asked for an afternoon (once "afternoon if possible", once "anything 2pm or later?"). When the patient then asked for an earlier date, the agent searched the new dates with only `date_range` and `specialty` and offered 8:00 to 9:30 AM times. The prompt said "with any time of day the patient gave" only in the several-weekday bullet, so nothing said the preference outlives a change of dates.

We (Nick and the agent) built `system.v15` on #251's `system.v14` (first built as `system.v14` on `system.v13`, then renumbered when #251 merged), with one new bullet in "Offering times" and two small rewordings. The wording that ships:

- **The bullet.** "The patient's time of day stays on every search until the patient changes it in words, in a booking and in a reschedule." Each later `check_availability` call keeps it when the dates change, when the patient asks for another provider and when they ask for "earlier", "sooner" or "the earliest". The latest time carries in the form the patient used: "morning" or "afternoon" as `time_of_day`, a clock bound or a specific time as `start_time` in HH:MM ("2pm or later" is `"14:00"`, and an afternoon `time_of_day` may go with it). A later statement replaces an earlier one, and a time in the same message as the new dates replaces it at once. Only "any time is fine", "mornings work too" or a new time ends it. The agent never pairs morning with a `start_time` from 12:00, a `start_time` it set itself to page past times it showed doesn't carry, and the time of an appointment the patient has or is moving is not their preference.
- **An empty search.** When a search that kept the time returns nothing, the reply says nothing was open at that time of day on those dates and asks one question, whether another time of day or later dates would work. It doesn't search again without the time on its own.
- **Two rewordings.** "search again with a wider date range or another provider" now says "keeping the patient's time of day as the next rule says", and "a later date range or a different time of day also works" became "a later date range also works, and a different time of day only when the patient asks for one".

The new L1 case is `l1-availability-keeps-stated-time-of-day`, modelled on run 38958895946: an afternoon dermatology search for Oct 12 to 16, an offer, then "is there anything earlier that week, like Thu the 8th or sooner with someone else?". It passes when some `check_availability` call covers Oct 8 (one call ending that day, or a call for that day alone) with `time_of_day: afternoon` or `start_time: "12:00"`.

## Why we chose what we chose

- **The time stays until the patient changes it in words, and an empty search ends in a question (r1/Q-1 (a)).** The alternative, widening the dates again with the time kept, would run two empty afternoon searches into the "repeated_failure" escalation, which the patient didn't ask for.
- **The latest time carries in the form the patient used (r1/Q-2 (a)).** Carrying only `time_of_day` (b) would turn "2pm or later" into "afternoon" and offer the 12:00 to 1:30 PM times the patient had passed over.
- **The case asserts at least one timed call, with no every-call check (r1/Q-3 (a)).** The alternative, an every-call flag on the L1 grader (c), would have touched `schema.ts` and `l1.ts`. The gap is known: a reply with one timed call and other untimed ones passes. The observed failure, no call keeping the time, fails. The case isn't tagged `smoke`, so the Eval gate doesn't grade it.
- **At least one failing trial before, three of three after (r1/Q-4 (a)).**
- **The same rule for a reschedule (A-4).** The time of the appointment being moved is not a preference, so the prompt says so.

## What surprised us

- **The prompt in `main` passed the first draft of the case three times out of three.** The patient's last line there was "is there anything earlier, like Thu the 8th or sooner with someone else?", and the agent kept `time_of_day: afternoon` every time, because the context's own earlier call showed it. Under r1/Q-4 (a) we reworded that one line toward the evidence's words ("earlier that week", with no check loosened) and measured again.
- **The model dropped the time in two trials out of three after that.** Both failing trials searched Oct 5 to 8 with `specialty` and `date_range` only, which is the miss from the Eval gate runs. The third kept `afternoon`.
- **The empty-search question isn't measured by any eval.** The case measures only the carry. The empty-search reply and the drop wording are pinned by content guards in `system.v15.test.ts`, each seen failing, but no live run has shown the model asking that question.

## Evidence

All runs: `--mode l1 --suite full --ids l1-availability-keeps-stated-time-of-day --profile sonnet-4.6 --trials 3`, case file and prompt as committed at the commit named on the line.

- **Before, first wording**, `system.v13` (`main` at `96bf912`): pass, pass, pass, `$0.0706` estimated. Every trial kept `time_of_day: afternoon`. Results file `2026-10-19T161645Z-l1-full-sonnet-4.6.json`.
- **Before, reworded last patient line**, `system.v13` (`main` at `96bf912`): pass, fail, fail, `$0.0505`. Both failures: `l1.action: args.time_of_day: expected "afternoon", got undefined`, and likewise `start_time`, for a call over Oct 5 to 8 with no time. Results file `2026-10-19T161724Z-l1-full-sonnet-4.6.json`.
- **After, first built on `system.v13` plus this rule** (named `system.v14` then, `14387d9`): pass, pass, pass, `$0.0855`. Every trial carried `time_of_day: afternoon`: one with a call per weekday Oct 5 to 8, two with one call for Oct 5 to 8. Results file `2026-10-19T161842Z-l1-full-sonnet-4.6.json`.
- **After, on `system.v15`** (`55d0c28`, on #251's `system.v14`): pass, pass, pass, `$0.0799`. Every trial carried `time_of_day: afternoon`: one with a call per weekday Oct 5 to 8, two with one call for Oct 5 to 8. Results file `2026-10-20T112000Z-l1-full-sonnet-4.6.json`. This is the result the PR stands on.
- The prompt took one wording, with no rewording of the rule needed.

## What's next

- The weekday preference ("Tue or Thu work best", run 38958895946) and the named Monday the agent didn't search (run 38955590583) are not covered. The rule keeps only the time of day and the earliest time.
- The Eval gate's smoke result for this prompt version goes in the PR once the PR is pushed.
