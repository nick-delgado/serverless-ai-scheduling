# 2026-10-17 — Times outside an offer list: `system.v9` passes the two-request case 3 of 3, and every undated time it wrote still left out "ET"

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #293, PR #319, #249 (PR #294), #284 (PR #311), #314 (PR #318), #301 (PR #307), #201, ADR-008, PRD FR-035, FR-030, FR-041

## What happened

In #249's runs of `clarify-two-requests-one-message` on sonnet-4.6, the case failed `times_in_clinic_tz_with_weekday` on times written outside an offer's time lines, such as a line before a tool call ("Let me check Dr. Haddad's availability for Thursday, October 22 at 10:00 AM right away.") and an offer's closing question. Nick filed #293 and settled the rules in its readiness review:

- **Before a search returns a time** (r1/Q-1 (a)): the line gives the weekday and the time with ET and no date. A range gets weekdays only.
- **In an offer message** (r1/Q-2 (a)): a sentence outside the day and time lines, such as the closing question or a lead-in, gives the weekday and the time with ET and no date. When two offered days share a weekday, it names no time.

The agent (task worker) bumped the prompt to `system.v9`, inside `packages/agent/src/prompts/` only, on top of #314's `system.v8`. It extended the pre-tool bullet, the "Always give times in Eastern Time" bullet, the no-date rule and the offer-format bullet in place, and added a content guard for each sentence.

The first k=3 run (`57c77c0`) passed 2 of 3 whole trials. The time check passed in all three. Trial 3 failed the question checks on its first reply: "Is this the one you'd like to move? If so, when would you like to reschedule it?" That is the second question the multi-request bullet already names. A-4 allowed one rewording, and Nick chose its scope ([recorded on #293](https://github.com/nick-delgado/serverless-ai-scheduling/issues/293#issuecomment-6237010729)): option (b), the question fix plus a tightening of the no-date wording, aimed at what the agent's hand count of run 1 showed. The rewording (`5334682`, `ae3e0c4`) does four things:

- It names a lone matching appointment in a statement instead of asking whether it is the one.
- It adds contrast examples: not "Would Monday, October 19 at 10:00 AM ET work?" and not "Let me check the week of October 19–23 at 10:00 AM."
- It says a single offered time also gets its day line and time line, and that a sentence about it still gives ET.
- It stops the relative-date sentence asking for the date in a sentence that also names a time no search has returned.

The re-run at `ae3e0c4` passed 3 of 3 whole trials, every check.

#301's lead-in pattern, a lead-in that names a time constraint ("Here are the available times on Thursday, October 15 at 1:00 PM or later:", which failed the time check in #301's fifth trial), is covered by the offer rule at `system.v9.ts`'s "Any other sentence in an offer message", but not measured: `clarify-two-requests-one-message` isn't #301's case, and none of its six trials here wrote a lead-in with a time constraint (r1/A-5).

## Why we chose what we chose

- **"Its weekday or "that day"" in the offer sentence.** r1/Q-2 (a) says the sentence "gives the weekday and the time with ET", but its own lead-in example, "Here are Dr. Haddad's openings that day from 1:00 PM ET:", has no weekday. The agent wrote "its weekday or "that day"", so #284's "that day" lead-in doesn't break the new rule. The alternative, the decision's words alone, would have contradicted its own example. The PR listed this under "Departs from or questions an owner decision", and Nick kept it in the review round (`19a0bc2/SPEC-3` (a), [on PR #319](https://github.com/nick-delgado/serverless-ai-scheduling/pull/319#issuecomment-6237946546)).
- **The rewording fixed a question failure, not a time one.** A-3 counts a whole trial, so a question-count miss also falls short. The agent proposed the question fix alone. Nick chose to add the no-date tightening in the same rewording, since the hand count showed the model not following that half of the rules ([recorded on #293](https://github.com/nick-delgado/serverless-ai-scheduling/issues/293#issuecomment-6237010729)). In the review round he confirmed that scope, the lone-appointment sentence included (`19a0bc2/SPEC-5` (a), [on PR #319](https://github.com/nick-delgado/serverless-ai-scheduling/pull/319#issuecomment-6237946546)).
- **The relative-date sentence is scoped, not removed.** "Whenever you resolve a relative date, say the exact date you used" pulled "(October 19–23)" into a pre-tool line in #293's after run and in run 1. `clarify-next-friday`'s judge scores `explicit_dates`, so the sentence keeps its job. It now makes an exception only for a sentence that also names a time no search has returned.
- **Contrast examples, despite #314's worry about copying.** #314 chose not to give an example of what not to ask, in case it was copied. Nick asked for explicit contrasts here. Run 2 shows no copy of either one.
- **Literal "ET" in the new sentences** (readiness r1, reuse), as the prompt already writes it, not `CLINIC.timezoneAbbrev`.

## What surprised us

- **Every undated time the agent wrote left out "ET", in both runs.** The graded form held: every time with a month-day that the time check could pair had its weekday and ET, in all six trials. But the times it wrote without a date ("at 10:00 AM that week", "Dr. Haddad has a 10:00 AM opening that week:") never carried ET: 4 of 4 in run 1 and 3 of 3 in run 2. FR-035 wants the zone on every time, and the check can't see these because it needs a month-day. So the 3 of 3 measures the dated form, not the whole rule.
- **The no-date half moved, in a small sample.** Run 1 wrote 4 dated times outside the time lines: a pre-tool range, two closing questions and one single-time sentence. Run 2 wrote 1. No closing question in run 2 named a time, and every run-2 offer had its day and time lines. One dated, zone-less sentence came back in run 2: "Dr. Haddad has 10:00 AM open on Monday, October 19." The time check doesn't pair it, because the time comes before the date.
- **The dry-run was 2.9× and 2.8× low.** It estimated $0.1838 each time. The runs cost $0.5349 and $0.5215 with the judge, just above the 1.7 to 2.7× range seen before.

## Evidence

Both runs were on sonnet-4.6, in scenario mode, with `--suite full --ids clarify-two-requests-one-message --trials 3 --max-cost 1.00`. The simulator was `sim.v1` on sonnet-4.6 and the judge was `judge.v1` on haiku-4.5. The results files are under `~/.local/state/serverless-ai-scheduling/eval-results/293-times-outside-offer-list/`.

| Run | Commit | Whole trials passed | Time check | Failed checks | Cost (agent + simulator; judge) | Results file |
|---|---|---|---|---|---|---|
| 1 | `57c77c0` | 2 of 3 | 3 of 3 | trial 3: `trajectory.max_questions_per_turn`, `invariant.one_question_at_a_time` | $0.5135; $0.0214 | `2026-10-17T153356Z-scenario-full-sonnet-4.6.json` |
| 2 (the one rewording) | `ae3e0c4` | 3 of 3 | 3 of 3 | none | $0.4905; $0.0310 | `2026-10-17T160906Z-scenario-full-sonnet-4.6.json` |

**Hand count from the transcripts (not a grader result).** The agent read every assistant message of both runs. The first table has each sentence that names a time before a tool returned it. The second has each closing question or lead-in of an offer message that names a time. Offer sentences that name no time are counted in the notes below.

Times named before a tool returned them:

| Run | Trial | Turn | Text | Date | Weekday | ET |
|---|---|---|---|---|---|---|
| 1 | 1 | 2 | "Let me check Dr. Haddad's availability at 10:00 AM the week of October 19–23." | yes (a range) | no | no |
| 1 | 2 | 2 | "Let me check Dr. Haddad's availability at 10:00 AM that week." | no | no ("that week") | no |
| 1 | 3 | 2 | "Let me check Dr. Haddad's availability at 10:00 AM that week." | no | no ("that week") | no |
| 2 | 1 | 2 | "Let me check Dr. Haddad's availability at 10:00 AM that week." | no | no ("that week") | no |
| 2 | 3 | 2 | "Let me check Dr. Haddad's 10:00 AM availability across that week." | no | no ("that week") | no |

In run 2, trial 2 also wrote a pre-tool line with dates and no time, "Let me check his availability the week of October 19–23." The no-date rule binds only a line that names a time.

Closing questions and lead-ins in an offer that name a time:

| Run | Trial | Turn | Kind | Text | Date | Weekday | ET |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 2 | lead-in | "Dr. Haddad has a 10:00 AM slot available that week:" | no | no | no |
| 1 | 1 | 2 | closing | "Would Monday, October 19 at 10:00 AM ET work, or would you prefer a different day?" | yes | yes | yes |
| 1 | 2 | 2 | lead-in | "Dr. Haddad has a 10:00 AM opening that week:" | no | no | no |
| 1 | 2 | 2 | closing | "Would Monday, October 19 at 10:00 AM ET work?" | yes | yes | yes |
| 1 | 3 | 2 | single-time sentence, no list | "Dr. Haddad has 10:00 AM open on Monday, October 19." | yes | yes | no |
| 2 | 1 | 2 | lead-in | "Dr. Haddad has 10:00 AM open on Monday, October 19. Here is that option:" | yes | yes | no |
| 2 | 3 | 2 | lead-in | "Dr. Haddad has 10:00 AM open every day that week. Here are your options:" | no | no ("every day") | no |

- Run 1 had 7 more offer closing questions and lead-ins that name no time, and run 2 had 9. Run 2 trial 1's offer ended in a restatement, which keeps the full `start_local`.
- No offer in either run had two days with the same weekday, so the "names no time" clause wasn't exercised.
- **Totals:** run 1 had 8 timed sentences outside the time lines, 4 of them dated and 2 with ET (the two dated closing questions). Run 2 had 4, 1 dated and none with ET. Neither run wrote a sentence in the form the rules ask for: weekday, time with ET, no date.

**Seen failing.** The content guards and the rest of the prompt edits are in the PR's `npm run mutate` table, taken at `ae3e0c4`.

## What's next

- #201 is where the suggested eval cases go (A-5): a case whose pre-tool line or lead-in names an undated time, graded for ET ([comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/201#issuecomment-6236535215)). **Later (2026-10-19):** #201 closes with PR #344, which adds the seven cases it had, T1 to T4 among them; suggested cases now go to #343 (see [the entry](2026-10-19-seven-suggested-cases-and-the-checks-l1-cannot-make.md)).
- #320: `times_in_clinic_tz_with_weekday` reads only month-day-then-time pairs and day-line lists. It misses an undated time and a time written before its date, which this entry's hand count found in both runs. That change needs an ADR-008 amendment. **Later (2026-10-17):** #320 made the check grade every clock time it didn't grade before, for ET and a weekday or "that day", and fails each hand-count row without ET; see [The time check now reads every clock time](2026-10-17-the-time-check-reads-every-clock-time.md).
- #321 (blocked by #320): undated times still leave out ET under `system.v9`'s rules, 7 of 7 across both runs. It also takes the review's note that the general "Always give times" bullet tells the model to date a returned time while the offer rule says not to (`19a0bc2/SPEC-4` (a), [on PR #319](https://github.com/nick-delgado/serverless-ai-scheduling/pull/319#issuecomment-6237946546)). **Later (2026-10-18):** #321 put ET on every undated time in `system.v10` and left one lead-in pattern, a time across several days with no weekday, to #326; see [`system.v10` puts ET on every undated time](2026-10-18-undated-times-now-carry-et-the-weekday-is-what-is-left.md). **Later (2026-10-18):** #326 took the pattern in `system.v11`: a lead-in that covers several days names no time; see [`system.v11` keeps a time out of a several-day lead-in](2026-10-18-several-day-offers-name-no-time.md).
- #234 and #251 take `system.v10` and later. They keep these rules and #314's bullets unless they measure better ones. **Later (2026-10-18):** #321 took `system.v10`; #234 and #251 take the next free number and keep its time rule; see [`system.v10` puts ET on every undated time](2026-10-18-undated-times-now-carry-et-the-weekday-is-what-is-left.md).
