# 2026-10-06 — An echoed floor is not a sixth option: max_five_options counts list lines

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #181, #170, PR #179, #98, #171, #178, #183, PRD FR-030

## What happened

`max_five_options` counted every `h:mm AM/PM` in an assistant message as an offered option. With #170's `start_time` input the model often names the floor it searched from ("Here are the open afternoon slots after 2:00 PM ET…"), and in PR #179's three-trial rerun of `book-derm-next-week-afternoon`, trial 2's only failure was that echoed floor read as a sixth option. Re-grading the 20 committed trials in `packages/evals/calibration/transcripts.json` showed the same false positive in all three of the trials whose scenarios list the invariant and that failed it: each one listed five options or fewer and repeated a time in prose.

Nick ran a readiness review on #181 and accepted every recommendation. The rule it settled (r1/Q-1 (a)): when at least one numbered or bulleted line (#98's list-item prefix) carries a clock time, only the times on list lines count. A message with no such line counts every time, as before. Prose that names more times beside a list ("Each day also has slots at 8:30, 9:00…") is not an offer (r1/Q-2 (a)). Times aren't deduplicated, so the same time for two providers is two options (r1/A-1), and the cap is per message (r1/A-2).

An agent built it. `packages/evals/src/graders/text.ts` gained `LIST_ITEM_PREFIX`, `listItemLines` (each list line with the index of its first character, for #178 to reuse) and `offeredClockTimes`, which keeps the `clockTimes` matches whose index falls inside a list line. The grader in `invariants.ts` now compares `offeredClockTimes(t).length` with `LIMITS.availabilityMaxSlots` (r1/A-4) and keeps its `${n} times in one message` detail (r1/A-5). The cases live in a new `packages/evals/test/max-five-options.test.ts` (r1/A-6).

## Why we chose what we chose

The readiness review settled the rule, the recorded and hand-built texts and the tests' home. These are the choices the agent made where the spec was still silent:

- **The counting rule lives in `text.ts` as `offeredClockTimes`, not inline in the grader.** The issue allowed either. In `text.ts` it sits beside `clockTimes` with its rule in one doc comment, #178 can import `listItemLines` from the same place, and the edit to `invariants.ts`, which #183 also changes, stays at five lines.
- **The prefix is anchored per line (`^…`, over `text.split("\n")`) rather than written as `(?:^|\n)…`.** The two match the same lines. The per-line form gives each line's start index directly, which `offeredClockTimes` needs, and it reuses `clockTimes`' match positions instead of adding a second clock-time regex.
- **A time counts when its match starts inside a list line.** The alternative, re-running `clockTimes` on each list line, would count the same times but lose their positions in the message.
- **A bold heading is not a list item.** `**Tuesday, October 13**` starts with `*`, but the prefix needs a space or tab after the marker, so `**After 2:00 PM on Tuesday:**` above a list is prose and its time doesn't count. A bulleted heading, `- After 2:00 PM on Tuesday:`, does count (r1/A-8), and a test pins that known gap.
- **The `invariants()` grading helper moved from `graders.test.ts` to `helpers.ts`**, as the review's reuse pointer suggested, so the new file imports it instead of copying it.
- **Every recorded trial in the new tests is graded with `max_five_options` passed explicitly**, not only the two `clarify-*` ones A-6 names. The tests read only that result, and passing it keeps each case independent of its scenario's list.
- **The two-digit bound of a list number is tested from below only.** Breaking `\d{1,2}` to `\d` turns the merged ten-line list's count from 10 to 9, and its test goes red. No test pins the upper bound (a three-digit "100." line), because no message numbers that far.

## What surprised us

The over-count was worse in the recorded runs than the one PR #179 trial suggested. All three recorded `max_five_options` failures were false positives, and none of them was a search floor: they were a floor and a ceiling in prose ("starting at 12:00 PM", "The latest I can see … is 1:00 PM ET"), and two summaries that named more times after a list. The two recorded messages that really list more than five options, `clarify-unsupported-specialty#1` (ten list lines, two providers at the same five times) and `clarify-two-requests-one-message#1` (one reschedule slot and five therapy slots), still fail, though neither scenario lists the invariant.

## Evidence

Per-message counted times of each recorded trial whose verdict could move, before (every clock time) and after (`offeredClockTimes`), from a re-grade with no model calls:

| Trial | Lists `max_five_options` | Before | After | Verdict |
|---|---|---|---|---|
| `book-derm-next-week-afternoon#1` | yes | 0,5,5,0,**7**,1,1 | 0,5,5,0,5,1,1 | fail → pass |
| `availability-cardiology-est-week#1` | yes | 5,0,**6** | 5,0,4 | fail → pass |
| `availability-derm-next-week-mornings#1` | yes | 5,0,0,0,**7**,0 | 5,0,0,0,5,0 | fail → pass |
| `reschedule-into-est-after-dst#1` | no | 0,1,0,**6**,0,2,0,1 | 0,1,0,5,0,2,0,1 | (fail → pass) |
| `clarify-two-requests-one-message#1` | no | 0,1,0,**8**,3,3 | 0,1,0,**6**,3,3 | (fail, stays) |
| `clarify-unsupported-specialty#1` | no | 0,0,**10**,5,5,0,1,1 | 0,0,**10**,5,5,0,1,1 | (fail, stays) |

The new tests assert each of these verdicts. Before the grader changed, 14 of the new file's 20 cases failed. `npm run mutate` broke each part of the rule (each prefix alternative, the indent, the space after the marker, the number width, the line anchor, the line-index step, both line bounds, the fallback, the limit and the detail count): 18 edits, 18 killed.

## What's next

- #178 can pair a listed time with the date heading above it by importing `listItemLines`.
- #171's before and after smoke runs should both use this grader, since `book-derm-next-week-afternoon` is a smoke case that lists `max_five_options`.
