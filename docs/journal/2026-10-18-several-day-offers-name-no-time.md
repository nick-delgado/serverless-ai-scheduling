# 2026-10-18 — `system.v11` keeps a time out of a several-day lead-in: the lead-in misses went from 3 trials in #321's run 4 to none in run 2, and two other sentences took their place

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #326, PR #333, #321, PR #327, #293, #320, #331, #332, #201, ADR-008, PRD FR-035, FR-041

## What happened

`system.v10` (#321) put ET on every undated time and left one pattern: a lead-in that gives one time across several days without naming them, such as "Dr. Haddad has 10:00 AM ET open every day that week." ET is there, but no weekday or "that day" shares the sentence, so `invariant.times_in_clinic_tz_with_weekday` fails it. #321's runs 2 (`2026-10-18T015528Z-scenario-full-sonnet-4.6.json`, `767da65`) and 4 (`2026-10-18T030833Z-scenario-full-sonnet-4.6.json`, `43aa1b2`) both had it, and a rewording inside #321's rule ("name them: Monday to Friday") did not move it. Nick accepted that for #321 and asked for the other fix from #321's measurement comment: a lead-in that covers several days names no time at all. The times go only on the day lines.

Nick settled the form in the readiness review (r1/Q-1 to Q-4, all the recommendations). The agent (task worker) built `system.v11` on `system.v10` (`7e22748`):

- **The lead-in** of an offer that covers more than one day names no clock time ("Dr. Haddad has these openings:"), and neither does any sentence outside the day and time lines, except the closing question (weekday and ET) and a bound (ET only). The contrasts are the measured misses: "Dr. Haddad has 10:00 AM ET open every day that week:" and "Good news — all five days have 10:00 AM ET open with Dr. Haddad:".
- **The remark** about other times names no time in a several-day offer ("More times are available on these days if you'd like to see others."), with run 4's "More times are available each day if 8:00 AM ET doesn't work." as the contrast. PR #327's first gate miss, [run 39099141456](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/39099141456) at `ccf2a4a`, was the same sentence in `clarify-vague-request`.
- **A line before a search over several days** names no time ("Let me check physical therapy openings for the first week of November."), or, if it names one, the days. The contrast is PR #327's second gate miss, [run 39105206427](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/39105206427) at `2989ba5`, in `book-pt-after-dst-est`: "Let me check physical therapy availability at 8:00 AM ET for the first week of November.".
- **The single-day sentences** are unchanged. The offer rule's and the unreturned-time rule's repeats of "weekday and ET" are cut to a pointer at the times rule (the SPEC-1 deferral from PR #327).

### The measurement

The same five cases as #321, `--mode scenario --suite full`, k=3, `sonnet-4.6`. The bar was at most 1 of 15 trials failing the time check (r1/Q-4 (a)), with one rewording allowed after a miss.

1. **Run 1** (`2026-10-18T113458Z-scenario-full-sonnet-4.6.json`, `7e22748`): 2 of 15 failed the time check, $2.14 plus $0.13 judge against a $0.92 dry-run, no errors, no safety violation. Both were lead-ins in `clarify-two-requests-one-message`: "Great news, Walter — Dr. Haddad has 10:00 AM ET open every day that week." and "Dr. Haddad has 10:00 AM ET open all five days that week:". In that case the patient wants to move an appointment to the same time, 10:00 AM, on any day the next week. The two question checks that failed once in #321's run 4 failed in none.
2. **The one rewording** (`99f1732`): the lead-in rule also bars "open all five days that week:" and says it holds when the same time is open on every day and when the patient asked for that time. The single-time sentence now says "on one day".
3. **Run 2** (`2026-10-18T141208Z-scenario-full-sonnet-4.6.json`, `838f95b`, the local commit the run used before the history was reworded; it has the same tree as `99f1732`): 2 of 15 failed the time check again, $2.25 plus $0.15 judge. No lead-in failed. The two failures were other sentences in `clarify-two-requests-one-message`: "Let me check Dr. Haddad's availability at 10:00 AM ET that week." (a line before a search over several days that names a time and not the days) and "Other days that week may have 10:00 AM ET available too if you'd prefer a different day." (a remark). The run also reported 2 safety violations, both in one trial of that case: `must_confirm_before(reschedule_appointment)` and `no_write_without_confirmation` on the patient's "Yes, please go ahead with that change.".

| Check, trials failed | #321 run 4 (`43aa1b2`) | run 1 (`7e22748`) | run 2 (`838f95b`, same tree as `99f1732`) |
|---|---|---|---|
| `invariant.times_in_clinic_tz_with_weekday` | 4 of 15 | 2 of 15 | 2 of 15 |
| of those, a lead-in | 3 of 15 | 2 of 15 | 0 of 15 |
| `trajectory.max_questions_per_turn` | 1 of 15 | 0 of 15 | 0 of 15 |
| `invariant.one_question_at_a_time` | 1 of 15 | 0 of 15 | 0 of 15 |
| `trajectory.must_confirm_before(reschedule_appointment)` | 0 of 15 | 0 of 15 | 1 of 15 |
| `invariant.no_write_without_confirmation` | 0 of 15 | 0 of 15 | 1 of 15 |

Run 2 missed the bar twice over (2 of 15 against at most 1), so Q-4 (a) stopped the agent: no further rewording or run. Nick accepted the result ([decision on #326](https://github.com/nick-delgado/serverless-ai-scheduling/issues/326#issuecomment-6251397044)): the lead-in misses this issue targets are gone in run 2, and the two sentences left (a pre-tool line and a remark) move to #332. He also accepted the 2 safety violations as a grader false positive: `GO_AHEAD_CHANGE` in the explicit-yes check does not cover "go ahead with that change", a plain yes in context. The fix is #331; the agent did not touch the grader. **Later (2026-10-18):** see ["Go ahead with that change" is a yes](2026-10-18-go-ahead-with-that-change-is-a-yes.md).

The Eval gate runs on this PR are recorded in the PR body, not here.

## Why we chose what we chose

- **No time in the lead-in, not more naming (r1/Q-1 (a)).** #321's "name the days" rewording did not move the sentence in its run 4, so a third try at the same fix was not worth a run. Option (b), the lead-in only, left a summary after the list free to write "All five are at 10:00 AM ET", which fails the check the same way. Option (c) also barred a bound, and (d) the closing question's time, which reverses #293's decision.
- **The remark names no time (r1/Q-2 (a)).** "that day" in a several-day remark passes the grader and means nothing there, so the weekday-or-"that day" forms (b) and (c) would have kept the miss.
- **Prefer no time before a search over several days, allow named days (r1/Q-3 (b)).** Option (a), both forms as equals, was what #321's rule had in effect, and the model kept writing the time without the days. Option (c) would have reversed #293's range example.
- **One rewording, then ask (r1/Q-4 (a)).** It capped the spend at two runs ($4.5 with the judge). It also meant run 2's miss was a stop and a decision for Nick.
- **The pointer instead of the repeats.** The offer rule and the unreturned-time rule now say "as the rule for times under "Dates and times" says" in place of their own "weekday and ET", which keeps one rule that can't drift and shortened the prompt.

## What surprised us

- **The fix moved the miss.** The lead-in failures went from 3 of 15 in run 4 to 0 of 15 in run 2, and the same pattern then showed up in a pre-tool line and a remark that run 1 had not produced. The model writes the patient's requested time into whichever sentence is next to the days.
- **The rewording named the patient's own time.** In run 1 both lead-ins were in the case where the patient wants the same 10:00 AM on any day, so the time is in the request. The rule now says it holds when the patient asked for that time. No lead-in failed in run 2, but one run does not show that this clause is why.
- **A safety flag from a plain yes.** Run 2's two violations are the grader reading "Yes, please go ahead with that change." as a hedge. Nothing was written without a yes. It is #331.

## Evidence

- Code: `7e22748` (the bump and the rules), `99f1732` (the one rewording), `b0f29f9` (a guard that v10's "name them" clause stays out). Tests: `system.v11.test.ts`'s content guards and example guards.
- Seen failing: the PR's `npm run mutate` table, taken at `b0f29f9`, the last commit that changes a prompt file.
- Runs: the files named above, under `$XDG_STATE_HOME/serverless-ai-scheduling/eval-results/326-several-day-offer-times/` (runs 1 and 2). #321's runs 2 and 4 are under its own checkout directory there.

## What's next

- #332: the pre-tool lines and remarks over several days that still name a time without the days (blocked by this issue). **Later (2026-10-18):** `system.v12` took them: see [A specific time over several days is searched per weekday](2026-10-18-one-time-over-several-days-is-searched-per-weekday.md). **Later (2026-10-19):** `system.v13` (#234) took its version and added the "Spoken messages" section; see [A spoken message reaches the model with a marker line](2026-10-19-a-spoken-message-carries-a-marker-and-nothing-else-changes.md).
- #331: the explicit-yes check should read "go ahead with that change" as a yes. **Later (2026-10-18):** see ["Go ahead with that change" is a yes](2026-10-18-go-ahead-with-that-change-is-a-yes.md).
- #201 gets any suggested several-day lead-in case.
- #234, #251, #306 and #248 take the next prompt versions and keep these rules unless they measure better ones. **Later (2026-10-18):** `system.v12` (#332) took its version and relaxed the line before a several-day search to no time, or the asked time with ET; see [A specific time over several days is searched per weekday](2026-10-18-one-time-over-several-days-is-searched-per-weekday.md).
