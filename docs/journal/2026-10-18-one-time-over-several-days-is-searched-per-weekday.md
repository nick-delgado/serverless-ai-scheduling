# 2026-10-18 — A specific time over several days is searched per weekday, and a line before that search may name the time with ET: the time check fails 0 of 15 trials in the measured run

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #332, PR #339, #326, #337, PR #338, #321, #293, #236, ADR-008, PRD FR-035

## What happened

#326's `system.v11` fixed the several-day offer's lead-in (0 of 15 trials in run 2, against 2 in run 1 and 3 in #321's run 4), but the time check still failed 2 of 15 in both runs. The misses had moved to two other sentences: a line before a search ("Let me check Dr. Haddad's availability at 10:00 AM ET that week.") and a remark ("Other days that week may have 10:00 AM ET available too if you'd prefer a different day.") in `clarify-two-requests-one-message`. Nick accepted that for #326 and filed #332.

The readiness review (round 1) found that the issue's Goal had the remark wrong. Both sentences came from one `check_availability` call over October 19 to 23 with `start_time: "10:00"` whose five slots all fell on Monday (`truncated: true`). So the offer showed one day, and `system.v11`'s one-day remark rule governed it, not #326's several-day rule. Nick's answer (r1/Q-1 (a)) was to stop keeping that one search: a request for one specific time on any of several weekdays now gets one search per weekday, as a broad request already does, and the offer shows every day that returned a slot. That removes the one-day view the remark came from.

We then went round the prompt three times with the agent measuring on the five #321/#326 cases at k=3, `sonnet-4.6`:

- `52cf880` (run 1): per-weekday search, and no clock time at all in a line before a search over several days.
- `6bbd694` and `a124941` (run 2): one rewording after run 1, then the quoted bad time sentences that runs copied word for word dropped from the offer and pre-tool rules. The offer rule's two date contrasts stay ([Decision c4816a0/SPEC-5](https://github.com/nick-delgado/serverless-ai-scheduling/pull/339#issuecomment-6257854260): the removal covers the time sentences, not every "not" example).
- #337 (PR #338) then changed the grader, after we read the failing sentences and found most were harmless: a pre-tool line now needs ET only, "every day that week" counts when five backing day lines list the time, and "ET and later" is a bound. See [A pre-tool line needs ET, not a weekday](2026-10-18-a-pre-tool-line-needs-et-not-a-weekday.md). Regraded under that rule, #332's runs fail 1 of 15 (run 1) and 3 of 15 (run 2), against 3 and 4 as recorded.

Round 2 of the readiness review, against `42db5f0`, asked what `system.v12` should now say, and Nick accepted every recommendation:

- **A line before a search over several days names no time, or the time the patient asked for with ET right after it and no weekday or days** (r2/Q-1 (b)): "Let me check Dr. Haddad's availability at 10:00 AM ET each day that week." passes, and the same line without ET fails. This reverses r1/Q-2 (a). A one-day line keeps its weekday ("Let me check Thursday at 10:00 AM ET."), so the times rule's "This covers a line before a tool call" now reads "a one-day line".
- **A several-day offer's lead-in still names no time**, even when every day line lists it (r2/Q-2 (a)): the form is only safe with five backing day lines, and the prompt would have had to teach that condition.
- **A fresh measurement allowance** (r2/Q-3 (a)): one rewording and up to two live runs on the PR head's text, with `main`'s grader.

## Why we chose what we chose

- **Search per weekday, not a changed remark (r1/Q-1 (a) over (b)).** A remark rule keyed on "fewer days shown than searched" would leave the patient seeing only Monday for a request about the whole week. The per-weekday search shows the asked time across the week, at the price of up to five tool calls in one reply. It narrows #236's one-search exception, so the L1 case `l1-availability-specific-later-time` accepts a call for 2026-11-02 alone as well as one over the week.
- **ET only in the line before a several-day search (r2/Q-1 (b) over (a) and (c)).** Keeping "no time at all" (a) asks the model for more than the grader checks, and it was not working: the remaining failures were pre-tool lines whose only fault was a missing ET. Relaxing every pre-tool line (c) would have dropped the one-day form's weekday, which the grader still enforces for a text with a day line, and reopened r1/A-6. So the relaxation covers only a line before a several-day search.
- **The no-ET contrast is in the prompt.** The prompt quotes "…at 10:00 AM each day that week." as the form not to write, since a missing ET was the failure in three of the four regraded trials. It is a constructed sentence, not a run's: we removed run-copied sentences in `a124941` and kept that removal.
- **The bound sentence and the "ET and later" form stay as they were (r2/A-2).** The prompt keeps asking more than the grader on two points (a weekday for any bound outside the listed words, and "ET or later" rather than "ET and later") because teaching "ET and later" would repeat an anchor that `packages/evals/test/undated-times.test.ts` checks exactly once.
- **The 12:00 PM aside is not fixed here (r2/A-3).** "Just to note, 12:00 PM does count as afternoon at Cedar Ridge, …" lacks ET and is neither of this issue's sentence kinds, but it counts toward the bar if it recurs.

## Evidence

- Code: `52cf880`, `6bbd694`, `a124941`, and `d3e3181` on top of `main` at `42db5f0`. The measured run used `d3e3181`.
- Runs: #326's run 1 (`2026-10-18T113458Z-scenario-full-sonnet-4.6.json`) and run 2 (`2026-10-18T141208Z-scenario-full-sonnet-4.6.json`), #332's two runs at `52cf880` and `a124941`, the per-trial regrade table on [#337](https://github.com/nick-delgado/serverless-ai-scheduling/issues/337#issuecomment-6256191613), and the L1 run of `l1-availability-specific-later-time` at `52cf880` (`2026-10-18T172250Z-l1-full-sonnet-4.6.json`): five calls, one per weekday, each with `start_time: "11:30"`, accepted by the new `any_of` option.
- Tests: `system.v12.test.ts`'s content guards (the pre-tool rule, the times rule's "one-day line", the per-weekday bullet, the lead-in, the remark) and its example guards (a timed example and a time-free example each).
- Seen failing: the PR's `npm run mutate` table. Each changed sentence has a KILLED row that restores its `system.v11` or earlier-v12 text.
- Measured run at `d3e3181` (results file `2026-10-19T004219Z-scenario-full-sonnet-4.6.json`; an earlier attempt at the same commit hit an expired SSO token and recorded 15 `error` trials at $0, which measured nothing): `invariant.times_in_clinic_tz_with_weekday` failed 0 of 15, against 2, 2, 3 and 4 as recorded in #326's two runs and #332's two (0, 2, 1 and 3 as #337 regraded them). Safety violations 0. One trial failed `trajectory.max_questions_per_turn` and `invariant.one_question_at_a_time`: `clarify-two-requests-one-message` t3's first reply asked "Is this the appointment you'd like to move? And when would you like to reschedule it to?", the lone-appointment rule v10 set and v12 does not touch. Under r1/Q-4 (a) any other failure misses the bar, so Nick accepted that trial as outside this change ([Decision #332/TWO-QUESTIONS](https://github.com/nick-delgado/serverless-ai-scheduling/issues/332#issuecomment-6257551937)) and the run counts as AC "Measured". The per-check table and the transcript reading are on #332.
- What the transcripts showed: the model wrote the prompt's own good form before the searches ("Let me check Dr. Haddad's availability at 10:00 AM ET each day that week.", four trials), and a time in the several-day lead-in ("Dr. Haddad has 10:00 AM ET open every day that week:", four trials) that the prompt says to leave out but the grader passes when five day lines back it. The 12:00 PM aside and the "Other days that week" remark did not recur. We found these by reading; the grader reported none of them.
- Cost: $2.06 (agent $1.91, judge $0.15), 27 minutes.

## What's next

- The Eval gate on the PR.
- #201 gets any suggested several-day lead-in case. **Later (2026-10-19):** #201 closes with PR #344, which adds the seven cases it had; suggested cases now go to #343 (see [the entry](2026-10-19-seven-suggested-cases-and-the-checks-l1-cannot-make.md)).
- #234, #251 and #306 take the next prompt versions and keep these rules unless they measure better ones. **Later (2026-10-19):** `system.v13` (#234) took its version and added the "Spoken messages" section; see [A spoken message reaches the model with a marker line](2026-10-19-a-spoken-message-carries-a-marker-and-nothing-else-changes.md). `system.v14` (#251) took the next version; see [A line before the first lookup](2026-10-19-a-line-before-the-first-lookup.md).
