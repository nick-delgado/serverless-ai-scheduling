# 2026-10-15 — Five options, grouped by day: one search per weekday spreads a broad request

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #236, #212, #282, #239 (PR #278), #233, #171, #36 (PR #235), ADR-008 ([2026-10-15 amendment, #236](../adr/0008-evaluation-strategy.md#amendment-2026-10-15-the-weekday-check-reads-times-listed-under-a-day-line-236)), PRD FR-030, FR-035

## What happened

On `dev`, during #36's run-through, Nick asked for Dr. Lee "next week" and got five options that each repeated the full date, all on Monday between 8:00 and 10:30 AM. A follow-up about Tuesday came back under a day heading instead, and asking the same thing again got "I just showed those above!" (#236). Separately, #212 tracked a reply that applied the five-option cap per day heading and listed seven times.

Nick combined the two into #236 and settled its two readiness rounds with the recommendations. An agent (Claude, as #236's task worker) built them:

- **`system.v4`** gives one offer format. A day line holds only the weekday, the date and a colon ("Tuesday, October 13:"). Under it, each time goes on its own "- " line with ET after it. The provider goes on each line only when there are several, and otherwise once, in a lead-in that gives no date. There are at most five options in total across all day lines (#212). A request over more than one weekday with no specific time gets one `check_availability` per weekday, in the same reply, for at most five weekdays, and the reply offers at most two times per day, in date order. A repeated question gets the same answer again, with no remark about it.
- **`times_in_clinic_tz_with_weekday`** grades the new format. A time listed under a day line takes its weekday from that line and needs ET on its own line. It reads the lines through #239's `headingListTimes`, exported and extended rather than copied (r2/A-1). ADR-008 gets a dated amendment saying so (r2/Q-1 (a)).
- **Five L1 cases** (`l1-offer-*`, full suite only, r1/Q-4 (a)) cover a single-day offer, a multi-day offer, a broad request's searches and reply, and a repeated question. The two smoke L1 cases that expected one whole-week search now also accept a search of the range's first day alone (r1/Q-1 (a)).

## Why we chose what we chose

The settled answers are on #236 (r1/Q-1 to Q-4, r2/Q-1). In short: per-day searches in one reply spread a week without adding a model call before the first text, which #251 shows is already over target. ET after each time keeps it where the weekday check already looked. Prompt only, no loop guard, for the five-in-total cap, because a guard costs a model call per miss.

Left open by the spec, and decided by the agent:

- **"Five weekdays" is written as a word, not tied to `LIMITS.availabilityMaxSlots`.** The two fives are different quantities (days searched, options shown), and tying them would change the search rule if the option limit ever moved.
- **The lead-in carries no date, with a worked example in the prompt.** The first wording ("name the provider once, before the list") let the model write "Dr. Priya Lee has these openings on Tuesday, October 13:" and then the day line, so the date appeared twice. Saying "a line before the list that gives no date" alone didn't fix it either. A complete example ("Dr. Lee has these openings:", then "Tuesday, October 13:", then "- 1:00 PM ET" and "- 1:30 PM ET", each on its own line) brought `l1-offer-single-day` to 3 of 4 trials. A stronger sentence ("never in the line before the list, even when the patient asked about that day") did no better (2 of 3), so we kept the shorter wording. When the patient names the day, the model still sometimes repeats it in the lead-in. The alternative was to accept the date in the lead-in, which is the form Nick reported.
- **A broad request's per-day searches set both `start_date` and `end_date` to that day.** r1/Q-1 (a) says "one call per weekday", and this is the call the new searches case expects.
- **The prompt says which replies keep the full `start_local`** (a restatement, a confirmation, a list of the patient's appointments; non-goal 1), so the format rule doesn't reach the confirmation checks.
- **The slot tests' `graded` and `checked` helpers moved to `packages/evals/test/helpers.ts`**, so the new grader tests share them instead of copying them.

## What surprised us

- **The before number for #212 was zero.** Three trials each of `book-derm-next-week-afternoon` and `reschedule-single-appointment` on `main` (`8e6d8ea`) had no message over five options. The over-five reply is intermittent: #212 saw it once on 2026-10-07, and PR #278's gate saw it on 2 of 5 runs ([38793901154](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38793901154) and [38826769844](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38826769844), "10 times in one message"). Three trials can't show a rate that low, so the prompt change went ahead, as the issue said it would whatever the number.
- **A format check in L1 counts as a safety violation.** ADR-008 counts L1 `must_match_none` and `must_not_contain` as safety checks, because the red-team cases use them for leak markers. So the first live run of the new cases reported "safety violations 1" for a date written twice. The cases aren't in the smoke suite, so the Eval gate never sees it, but a full-suite run feeds PRD §7's "0 safety violations". #282 tracks a non-safety variant.
- **Per-day searches worked on the first try.** For "next week", sonnet-4.6 made five `check_availability` calls in one reply, one per weekday, on every run.

## Evidence

- #212's measurement (sonnet-4.6, 3 trials each of `book-derm-next-week-afternoon` and `reschedule-single-appointment`, no judge; messages over five counted by `offeredClockTimes`, the rule `max_five_options` uses):
  - `main` at `8e6d8ea`: 0 of 30 assistant messages over five, and all 6 trials pass ($0.56).
  - This branch at `1a2bb07`: 0 of 33 over five ($0.96). 5 of the 6 trials pass. `book-derm-next-week-afternoon#3` failed `end_state.appointment` ("weekday is Mon"). The agent searched each weekday, offered Monday to Wednesday at noon, and after the patient asked for 1 PM or later it offered Monday and Tuesday. The simulated patient chose Monday, though its hidden facts say Tuesday or Thursday. The agent restated, got a yes and booked what was chosen. Showing Monday first is the spread rule working (days in date order), so this case now leans more on the simulator keeping to its flexible days.
- New L1 cases, live (sonnet-4.6, full suite): with the first wording, 4 of 5 at 1 trial, `l1-offer-single-day` failing on the repeated date. After the worked example (`1a2bb07`), `l1-offer-single-day` passed 3 of 3 alone, then 4 of 5 for the five cases at 1 trial, with `l1-offer-single-day` failing once more on the same date in the lead-in. The other four passed every run.
- Recorded-trial sweep (`failing("times_in_clinic_tz_with_weekday")` over the 20 trials in `packages/evals/calibration/transcripts.json`): none fail after the change. The change only adds checks, so none failed before either.
- Grader and case tests: `packages/evals/test/offer-format.test.ts`. Seen failing: the PR's `npm run mutate` tables.
- The `Eval gate` on the PR: see the PR body.

## What's next

- #282: a non-safety negative check for L1 format cases.
- The baselines still record `system.v3`; the gate only warns about the version until the next re-record (non-goal 2).
