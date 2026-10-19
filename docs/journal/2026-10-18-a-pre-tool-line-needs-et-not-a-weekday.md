# 2026-10-18 — A pre-tool line needs ET, not a weekday: regraded offline, the four runs' failing trials fall from 11 of 60 to 6

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #337, PR #338, #320, #326, #332, #321, #293, #236, #328, ADR-008, PRD FR-035, §7

## What happened

Four prompt rounds (#321, #326, and #332's two runs) tried to stop the model writing "X AM ET every day that week". The misses moved but didn't shrink: #332's second run failed 4 of 15 trials on `invariant.times_in_clinic_tz_with_weekday`, against `system.v11`'s 2 in the run before. Removing the prompt's quoted bad examples didn't help either. After #332's last allowed run Nick asked whether the rule was asking for the right thing, and filed #337.

We read the failing sentences in the four results files (an agent did the reading, and the task worker checked it against the recorded events). Most were sentences a patient can't misread: "Let me check Dr. Haddad's availability at 10:00 AM ET each day that week." before a search, and "Dr. Haddad has 10:00 AM ET open every day that week." above five day lines that each say 10:00 AM ET. Neither claims a time no tool returned. The one that did, "Other days that week may have 10:00 AM ET available too" after a search that returned Monday only, is a real unverified claim, and the weekday rule only catches it by accident.

Nick settled four questions in the readiness review (round 1), and the agent (a task worker) built them:

- **Pre-tool lines need ET only**, read by position. The grader now gets each assistant text with a flag for whether a tool call follows it directly in the same reply (an `assistant` event then a `tool_call` of the same turn; in L1, the model's text when it made any tool call). A text with a day line keeps the full rule.
- **A several-day phrase counts as a weekday only when it is backed**: the same text has Monday-to-Friday day lines and each lists that time.
- **"ET and later" is a bound**, in the grader only.
- **No prompt change**: `packages/agent/` is untouched.

## Why we chose what we chose

- **By position, not by wording (Q-1 (b) over (c)).** A closed list of check phrases ("Let me check", "I'll look") misses "One moment while I search 10:00 AM ET each day", and it would pass such a sentence even with no search after it. Position can't be gamed by phrasing, and the day-line test stands in for "claims no availability": an offer that ends with another search keeps its weekday rule. The cost is a signature change in both modes, which reverses #320's decision to keep the check texts-only.
- **Backed, not everywhere (Q-2 (c) over (b)).** Letting "every day that week" count anywhere would have passed an "every day" said after a search that returned one day. Requiring the five day lines, each with the time, means the phrase can't be wrong about what follows it. A lead-in in one text and day lines in a later text don't back each other, since "message" means one assistant text.
- **ET stays required everywhere (A-1).** Four of the six still-failing trials fail on a missing ET, which is the rule's other half. We did not loosen it, because "10:00 AM" with no zone is the misreading FR-035 exists to prevent.
- **"Holding no day line" is `headingListTimes(text)` finding nothing (our reading of Q-1 (b)).** The decision left the test open. The alternative was any list line or any "Monday, October 19:" heading, which would also have exempted a text whose only list is the clinic's hours; reusing the day-line reader keeps one definition of a day line across the grader.
- **A backing day line must list the time in 24-hour terms, and every Monday-to-Friday line in the text must (our reading of Q-2 (c)).** The alternative was one matching line per weekday, which would let a second Thursday line with another time stand beside a matching one. Comparing `HH:MM` also means "10:00 AM ET" and "10:00 a.m. ET" back the same sentence.
- **Grader only for "and later" (Q-3 (b) over (c)).** Teaching the prompt a second bound form would have bumped the prompt version during a round that was about the grader, for a form that appeared in one trial of 60.
- **No prompt change (Q-4 (a)).** The prompt now asks for more than the grader checks on three points: `system.v11` still asks for a weekday in a pre-tool line, still tells the model not to write a several-day lead-in, and its bound sentence (`system.v11.ts:153`) still asks for a weekday after "ET and later". #332 decides, when it is unparked, whether `system.v12` keeps or relaxes them.

## Evidence

- Offline regrade of the four results files, no model call. Trials failing the check, before and after: #326 run 1, 2 and 0; #326 run 2, 2 and 2; #332 run 1, 3 and 1; #332 run 2, 4 and 3. That is 11 of 60 before and 6 after, graded at `03fd561` (the "after" grader; "before" is `main` at `686cb3a`). The "before" grading matched each file's recorded status in all 60 trials. The per-trial table is on #337.
- The six that still fail: four lack ET (three pre-tool lines and the 12:00 PM aside), one is #326 run 2's unverified "Other days that week" remark, and one is a lead-in ("Dr. Haddad has 10:00 AM ET open that week:") that was followed by a search and has day lines, so it keeps the weekday rule.
- Tests in `packages/evals/test/undated-times.test.ts` (a block per sentence of the issue's table, plus the position, day-line and bound edges) and `packages/evals/test/l1.test.ts` (the L1 flag). No existing expectation changed, the calibration pin in `packages/evals/test/offer-format.test.ts` included.
- Seen failing: the PR's `npm run mutate` table. Each path (the position read, the turn check, the day-line guard, each of the five weekdays in `WORKDAYS`, the time match, the `and` connective) has a KILLED row.

## What's next

- #332 unparks: it merges `main` and settles in its own round whether `system.v12` relaxes the pre-tool and several-day rules the grader no longer enforces. **Later (2026-10-18):** `system.v12` relaxed the line before a search over several days to no time, or the asked time with ET and no weekday. It kept the one-day line's weekday, the several-day offer's time-free lead-in, and the bound sentence (weekday after any bound wording outside the listed words, "ET or later" only). See [A specific time over several days is searched per weekday](2026-10-18-one-time-over-several-days-is-searched-per-weekday.md).
- **Later (2026-10-19):** #340 added "every day next week", "each day next week", "all five days next week", "both days" and "each of those days" to the backed several-day phrases, each accepted only when the text's day lines back it. See [The grader reads "every day next week" and "on both days" as naming the days when day lines back them](2026-10-19-backed-several-day-leadins-in-more-wordings.md).
- A true-but-unbacked claim ("Other days that week may have 10:00 AM ET available too") still passes only if it names a weekday. A check on unverified availability claims belongs to `no_hallucinated_slots`, not to this rule.
