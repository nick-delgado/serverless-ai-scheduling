# 2026-10-17 — The time check now reads every clock time: 7 of the 20 recorded trials fail it, and so does every undated time in #293's runs

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #320, PR #322, #293 (PR #319), #321, #236, #239, #201, ADR-008, PRD FR-035, FR-041

## What happened

`times_in_clinic_tz_with_weekday` graded only two shapes: a month-day followed by a time (`dateTimeMentions`), and a time listed under a day line (#236). #293's no-date rules (`system.v9`) tell the model to write a time with no month-day in a pre-tool line, a lead-in and a closing question, so the common form went ungraded. #293's hand count found every undated time in its two k=3 runs left out ET, 7 of 7, while the check passed all six trials ([results comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/293#issuecomment-6236566695)). Nick filed #320 and settled the rule in its readiness review: every `h:mm AM/PM` time the two old readers don't claim is graded, wherever it is (r1/Q-1 (a)); each needs ET, and a weekday or "that day" in its sentence unless it is a bound such as "before 12:00 PM ET" (r1/Q-2 (c)); "10 AM" stays ungraded (r1/Q-4 (a)).

The agent (task worker) added the reading as two functions in `packages/evals/src/graders/text.ts`: `unclaimedTimes` finds the times and their sentences, and `unclaimedTimeLacks` says what one lacks. `timesWithoutWeekdayOrZoneProblem` checks pairs, then day-line times, then the new times, so a reply that failed before fails with the same detail. `dateTimeMentions`, `slotMentions`, `headingListTimes` and `no_hallucinated_slots` didn't change (r1/A-1). ADR-008 has the rule as its 2026-10-17 amendment for #320.

Before opening the PR, the agent regraded the recorded transcripts at `6f3ce28` with a throwaway script outside the checkout (r1/A-6), with no model call. The results are in [the issue comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/320#issuecomment-6239796591):

- **#293's two runs:** every one of the ten hand-count sentences without ET now fails, and the two dated closing questions ("Would Monday, October 19 at 10:00 AM ET work?") pass. Of the six trials, all of which passed the check before, five now fail it; run 2's trial 2 still passes because it wrote no undated time.
- **The 20 recorded trials** (`packages/evals/calibration/transcripts.json`): 0 failed before, 7 fail now. Each fails on a time outside an offer list: "starting at 12:00 PM", "slots after 3:00 PM", "11:30 AM isn't showing", "a 2:30 or 3:00 PM slot".
- **The baseline's own smoke run** (`system.v3`, 2026-10-13): two cases that passed now fail, `book-derm-next-week-afternoon` ("before your 2:30 PM conflict") and `book-pt-after-dst-est` ("there is an 8:00 AM slot available").
- **The newest gate run on `system.v9`** (PR #319, [run 39055652853](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/39055652853)): none of its eight smoke cases fails the new rule.

Nick waived the re-baseline that r1/Q-3 (a) would have asked for ([decision on #320](https://github.com/nick-delgado/serverless-ai-scheduling/issues/320#issuecomment-6239989073)). Two smoke cases fail on the baseline's `system.v3` run, but the gate compares a fresh `system.v9` run against the baseline's statuses, and the latest `system.v9` gate run fails none. So the PR's own Eval gate decides: if it shows two or more smoke scenario cases failing only on this check, the agent re-records the baseline in this PR after Nick approves the estimate; with at most one, the baseline stays as it is. The first gate run, [39064674580](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/39064674580) at `0cdd23a`, passed every case in both modes.

After the review's `0cdd23a/SPEC-1` (a) cut the window at the next clock time, the agent re-ran the regrade at `8888218`. The results didn't move: no case newly fails on either `system.v9` gate run (39055652853 and 39064674580), the baseline's `system.v3` run still fails the same two, and the recorded set still fails the same 7.

## Why we chose what we chose

- **Two functions, not an extension of `mentionHasWeekdayAndZone`.** A-1 suggested a separate function. The rule for a new time differs from both old shapes (its weekday is anywhere in its sentence, and a bound needs none), so a third branch in that function would have mixed three readings in one. The agent kept `mentionHasWeekdayAndZone` and its doc as they were.
- **A plain "AM." ends the sentence.** r1/Q-2's edges say a period inside a clock time ends no sentence, naming "10:00 a.m.". `CLOCK_TIME_SOURCE` also takes in the period after a plain "AM" or "PM", so "starting at 8:00 AM. Here's a summary…" would have run on into the next sentence, and a weekday there would have counted. The agent read only the dotted form's periods as part of the time; the period after a plain "AM" ends the sentence and is left out of the time in the detail. The alternative, every period the regex takes in, would have let the next sentence's weekday pass a time. Nick accepted this reading and the next four with the PR review's `0cdd23a/SPEC-4` (a) ([decision](https://github.com/nick-delgado/serverless-ai-scheduling/pull/322#issuecomment-6240955807)).
- **"Eastern Time or later" is a bound.** r1/Q-2 (c) says a time "followed by "or later" or "or earlier" after its ET". The agent read "Eastern Time" as an ET spelling there too, since `ZONE_RE` already reads "Eastern". The alternative, "ET" alone, would have failed the prompt's own clinic-hours spelling followed by "or later".
- **The range start looks only at the next time.** r1/Q-2's edges say a time followed by "to", "until", "till", "-" or "–" and then another clock time takes that time's ET. The agent reads the gap to the next clock time and requires it to be only that word or dash (`RANGE_END` anchored at the start), so "8:00 AM, staying open until 5:00 PM Eastern Time" gives 8:00 AM no ET. The alternative, `RANGE_END` unanchored as the slot check uses it, would have let any gap that ends in "until" borrow the end's ET.
- **"Dr" counts as the title only as a whole word.** r1/Q-2's edges exempt "the period of "Dr."". The agent reads "Dr" right before a period as the title only when it is a whole word, so "with CDr. 10:00 AM ET is open." ends its first sentence at that period. The alternative, any "Dr" before a period, would have let a word ending in "Dr" join two sentences.
- **The detail names the sentence.** A-2 fixes only the old details. The agent added the sentence to the new one (`"10:00 AM" lacks ET, in "Let me check …"`), since a time alone, such as "10:00 AM", doesn't say which of a reply's times failed.
- **A weekday-only line's list now fails the ET check too.** AC 2 keeps the "day-line rows" of the L1 offer tables. The rows that replace the day line with "Tuesday:" are no day-line rows, and r1/Q-1's edges say "Tuesday:\n- 1:00 PM ET" fails, with the weekday read from the time's own line. So those seven rows now expect `invariant.times_in_clinic_tz_with_weekday` beside `contains_all`. The PR listed this under "Departs from or questions an owner decision", and Nick kept it (`0cdd23a/SPEC-3` (a), [decision](https://github.com/nick-delgado/serverless-ai-scheduling/pull/322#issuecomment-6240955807)).
- **A list time needs its own ET.** The PR review found that the 16-character window let a list time take a later time's ET: "9:30 AM, 10:00 AM ET" passed on 9:30 AM, though r1/Q-2's edge says "each time needs its own", while r1/A-10 keeps the window "unchanged". Nick chose `0cdd23a/SPEC-1` (a) ([decision](https://github.com/nick-delgado/serverless-ai-scheduling/pull/322#issuecomment-6240955807)): for a newly graded time, and for its range end, the window also stops where the next clock time starts. Pairs and day-line times keep the plain window. The alternative, the plain window with the amendment corrected, would have counted "9:30 AM or 10:00 AM ET" as compliant in #321's measurements.

## What surprised us

- **The recorded set went from 0 to 7 of 20.** None of the 20 `system.v1` trials failed the check before; a third fail it now, every one on a time the old readers didn't see. The undated time without ET wasn't new with `system.v9`: it was in the model's writing all along.
- **On the smoke suite at k=1, the current prompt passes where the old one fails.** The baseline's `system.v3` run fails two smoke cases under the new rule, and the newest `system.v9` gate run fails none. That is one trial per case. It isn't evidence that `system.v9` writes ET on undated times: #293's k=3 runs of `clarify-two-requests-one-message` show it still leaves ET out, which is #321's target.

## Evidence

- Code: `6f3ce28`, then `6db0495` for the review round. Tests: `packages/evals/test/undated-times.test.ts` (#293's 12 sentences, `system.v9`'s five compliant examples, and a passing and a failing fixture for each rule), and the updated pins in `offer-format.test.ts` and `false-positives.test.ts`.
- Seen failing: the PR's `npm run mutate` table.
- Regrade: [issue comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/320#issuecomment-6239796591), taken at `6f3ce28`.

## What's next

- #321 adds ET to undated times in the prompt; this check now measures it.
- #201's suggested L1 cases, a dated closing question among them (r1/A-3), stay there.
