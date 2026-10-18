# 2026-10-18 — `system.v10` puts ET on every undated time: the four smoke cases fell from 5 of 24 failing trials to 1 of 12, and one lead-in still leaves out the weekday

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #321, PR #327, #293 (PR #319), #320 (PR #322), #326, #234, #251, #201, ADR-008, PRD FR-035, FR-041

## What happened

`system.v9` told the model to write a time before a search, or in an offer's lead-in or closing question, as a weekday and the time with ET and no date. #293's hand count found it never did: every undated time left out ET, 7 of 7. #320 then made `times_in_clinic_tz_with_weekday` grade every `h:mm` time, so the miss became a failing check. #321's job was the prompt side.

Nick settled the form in the readiness review: one general rule for every clock time, not more examples on three sentence kinds (r1/Q-1 (a)). The agent (task worker) turned the "Always give times" bullet into that rule in `system.v10`:

- every time written as `h:mm AM/PM` has ET right after it, and its weekday or "that day" in the same sentence;
- the bullet names the places it covers: a line before a tool call, an offer's lead-in, closing question and single-time sentence, a bound, a time echoed back or said not to be open, and a conflict;
- a time right after one of #320's bound words ("before", "after", "from", "until", "till", "by", "starting at", "up to"), or followed by "ET or later" or "ET or earlier", needs ET only. Any other bound wording ("past 2:00 PM ET") needs a weekday too;
- the date goes on a time a tool returned, and never in an offer message's other sentences (the `19a0bc2/SPEC-4` note from #319);
- the pre-tool-line rule and the unreturned-time rule point to it; the offer rule's remark and single-time sentences restate the requirement and gained their own "not" contrasts, drawn from measured `system.v9` misses. The offer rule itself has no pointer to the bullet, and the pre-tool and unreturned-time rules keep their own "weekday and ET" wording; the review caught this and Nick deferred it to #326 ([decision](https://github.com/nick-delgado/serverless-ai-scheduling/pull/327#issuecomment-6246664477)).

The ZONE_WINDOW comment in `packages/evals/src/graders/text.ts` now says which times use `zoneAfter` (the `4f24cf7/VER-2` note from #322); no code in that file changed.

### The measurement

Five cases, `--mode scenario --suite full`, k=3, `sonnet-4.6`, counted by `invariant.times_in_clinic_tz_with_weekday` per trial. The before rate is `system.v9`'s, from #320's journal (six recorded smoke runs per smoke case) and, for `clarify-two-requests-one-message`, #293's run 2 regraded with `main`'s grader (2 of 3). All numbers are from the results files named below, and each ran on the commit named.

| Case | `system.v9` before | run 2, `767da65` | run 4, `43aa1b2` |
|---|---|---|---|
| `book-derm-next-week-afternoon` | 1 of 6 | 0 of 3 | 0 of 3 |
| `book-pt-after-dst-est` | 2 of 6 | 0 of 3 | 1 of 3 |
| `reschedule-single-appointment` | 1 of 6 | 0 of 3 | 0 of 3 |
| `clarify-vague-request` | 1 of 6 | 0 of 3 | 0 of 3 |
| `clarify-two-requests-one-message` | 2 of 3 | 3 of 3 | 3 of 3 |

The runs:

1. **Run 1** (at `767da65`) was lost: the agent started it as a background command with a 10-minute timeout, and the harness killed it before it wrote a results file. Its spend is unknown, at most the $3.00 cap.
2. **Run 2** (`2026-10-18T015528Z-scenario-full-sonnet-4.6.json`, `767da65`): 3 of 15 trials failed the time check, all in `clarify-two-requests-one-message`, $1.85 against a $0.92 dry-run. Every failing sentence had ET and lacked a weekday: "Both are at 12:00 PM ET;" (the weekdays were in the previous sentence), "Let me check Dr. Haddad's availability at 10:00 AM ET the week of October 19–23.", and "Dr. Haddad has 10:00 AM ET open every day that week.".
3. **The one rewording** (`43aa1b2`): "ET alone is not enough, and a weekday in another sentence doesn't count", with the first two sentences as contrasts, and a "name the days" contrast on the single-time rule.
4. **Run 3** (`2026-10-18T022710Z-scenario-full-sonnet-4.6.json`, `43aa1b2`): 15 of 15 trials errored with Bedrock `ServiceUnavailableException` on the first simulator call, $0. Nothing was measured. A one-trial check afterwards ran to the end (`2026-10-18T030541Z-scenario-full-sonnet-4.6.json`, about $0.2) and failed the time check on "Let me check Dr. Haddad's availability at 10:00 AM ET the week of October 19 to 23.".
5. **Run 4** (`2026-10-18T030833Z-scenario-full-sonnet-4.6.json`, `43aa1b2`): 4 of 15 failed, $2.41, no errors and no safety violations. The failing sentences, all with ET and no weekday: "More times are available each day if 8:00 AM ET doesn't work." (`book-pt-after-dst-est`, the remark rule's own contrast used the wrong way round), and "Dr. Haddad has 10:00 AM ET open every day that week.", "Dr. Haddad has 10:00 AM ET open all five days that week:" and "Good news — all five days have 10:00 AM ET open with Dr. Haddad:" (`clarify-two-requests-one-message`, each in one trial).

r1/Q-3 (a)'s bar was at most 1 of 15. Neither run 2 nor run 4 met it. Nick accepted the result as it stands for this issue ([decision on #321](https://github.com/nick-delgado/serverless-ai-scheduling/issues/321#issuecomment-6245857206)): the ET half is fixed, the four smoke cases the Eval gate runs fell from 5 of 24 failing trials on `system.v9` to 1 of 12 in run 4, and the rest is one pattern in a full-suite case. #326 takes that pattern: a lead-in that covers several days names no time.

The agent also counted three things the grader doesn't see (A-9), over runs 2 and 4. No time written without minutes ("10 AM") appeared in either run. No month-day appeared in a closing question in either run. A month-day appeared in a line before a tool call 6 times in run 2 and once in run 4: in run 2, two of the six were "the week of October 19" beside a time (a date the prompt forbids there), and the other four, and run 4's one, were an appointment the tool had returned, which carries its date. "That day" appeared in no line before a tool call.

## Why we chose what we chose

- **One general rule, not more examples (r1/Q-1 (a)).** Option (b), more examples on the Goal's three sentence kinds, would have left bounds, remarks, echoed and refused times without text, and #320's grader reads all of them. Option (c), naming no time in a lead-in or a question, would have reversed two #293 decisions. Run 4 shows the cost of (a): one lead-in shape still slips, and #326 is that pattern's fix.
- **ET only for a bound, as the grader reads it.** A bound word from #320's list needs no weekday, so the prompt says so and gives "Here are options after 2:00 PM ET.", not "Here are options after 2:00 PM.", the exact miss from #320's gate run. The agent used "past 2:00 PM ET" as the out-of-list bound example. The issue's edges said "at or after 2:00 PM ET" needs a weekday, but the grader's `BOUND_BEFORE` reads only the word right before the time, so that wording passes as a bound; the PR records the error.
- **Rewording once, by the failing sentences.** Run 2's three sentences all had ET and no weekday, so the rewording added "ET alone is not enough" and a contrast for each. It did not move `clarify-two-requests-one-message` (3 of 3 before and after).
- **Raising one test's ceiling.** `estimate-calibration.test.ts` checks the L1 smoke estimate against the cost of `system.v1`-era runs. The longer prompt took it from 1.484 times the recorded cost on `system.v9` (`4804c58`) to 1.532 on `system.v10` (`43aa1b2`; 1.518 at `767da65`, before the rewording), past the 1.5 ceiling. The agent could not shorten the rule by half to stay under, so the ceiling is 1.6 ([decision on #321](https://github.com/nick-delgado/serverless-ai-scheduling/issues/321#issuecomment-6243962707)).

## What surprised us

- **A fix for one miss moved the failing sentence to the next miss.** Every sentence that failed in runs 2 and 4 had ET. The model took the ET half of the rule at once and left out the weekday half where the sentence was about "every day that week", which is the form the rule's own "that week is no day" contrast warns about.
- **A lost run and an outage cost two approvals.** The first run was killed by a harness timeout the agent set, and the next ran into a Bedrock outage that failed all 15 trials. Neither produced a number, and the first's spend is unknown.

## Evidence

- Code: `767da65` (the bump and the rule), `43aa1b2` (the one rewording). Tests: `system.v10.test.ts`'s content guards and structural example guard.
- Seen failing: the PR's `npm run mutate` table, taken at the PR head.
- Runs: the files named above, under `$XDG_STATE_HOME/serverless-ai-scheduling/eval-results/321-undated-times-et/` (runs 3 and 4 and the check), run 2 as well.

## What's next

- #326: a lead-in covering several days names no time (blocked by this issue). Its rewrite of the offer rule also adds the pointer to the bullet that this entry says is missing.
- #328: a test that keeps the prompt's bound-word list and the grader's `BOUND_BEFORE` and `BOUND_AFTER` in step.
- #234 and #251 take the next prompt version and keep these rules unless they measure better ones.
- The Eval gate on this PR measures the four smoke cases at k=1 against the `system.v9` baseline, which Q-4 (a) left as it is.
