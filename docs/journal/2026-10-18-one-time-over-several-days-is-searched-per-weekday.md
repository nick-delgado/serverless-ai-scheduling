# 2026-10-18 — A specific time over several days is searched per weekday, and a line before that search may name the time with ET

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #332, #326, #337, PR #338, #321, #293, #236, ADR-008, PRD FR-035

## What happened

#326's `system.v11` fixed the several-day offer's lead-in (0 of 15 trials in run 2, against 2 in run 1 and 3 in #321's run 4), but the time check still failed 2 of 15 in both runs. The misses had moved to two other sentences: a line before a search ("Let me check Dr. Haddad's availability at 10:00 AM ET that week.") and a remark ("Other days that week may have 10:00 AM ET available too if you'd prefer a different day.") in `clarify-two-requests-one-message`. Nick accepted that for #326 and filed #332.

The readiness review (round 1) found that the issue's Goal had the remark wrong. Both sentences came from one `check_availability` call over October 19 to 23 with `start_time: "10:00"` whose five slots all fell on Monday (`truncated: true`). So the offer showed one day, and `system.v11`'s one-day remark rule governed it, not #326's several-day rule. Nick's answer (r1/Q-1 (a)) was to stop keeping that one search: a request for one specific time on any of several weekdays now gets one search per weekday, as a broad request already does, and the offer shows every day that returned a slot. That removes the one-day view the remark came from.

We then went round the prompt three times with the agent measuring on the five #321/#326 cases at k=3, `sonnet-4.6`:

- `52cf880` (run 1): per-weekday search, and no clock time at all in a line before a search over several days.
- `6bbd694` and `a124941` (run 2): one rewording after run 1, then the quoted bad sentences dropped from the offer and pre-tool rules, because a run copied one word for word.
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

- Code: `52cf880`, `6bbd694`, `a124941`, and this round's commit on top of `main` at `42db5f0`.
- Tests: `system.v12.test.ts`'s content guards (the pre-tool rule, the times rule's "one-day line", the per-weekday bullet, the lead-in, the remark) and its example guards (a timed example and a time-free example each).
- Seen failing: the PR's `npm run mutate` table. Each changed sentence has a KILLED row that restores its `system.v11` or earlier-v12 text.
- Measured run: to be added after the live run, with the results file name, the per-check table (#326 runs 1 and 2, #332 runs 1 and 2 as recorded and as regraded, and this run) and each failing sentence.

## What's next

- The measured run on the PR head, then the Eval gate.
- #201 gets any suggested several-day lead-in case.
- #234, #251 and #306 take the next prompt versions and keep these rules unless they measure better ones.
