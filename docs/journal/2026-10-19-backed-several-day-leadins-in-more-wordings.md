# 2026-10-19 — The grader reads "every day next week" and "on both days" as naming the days when day lines back them: PR #339's two gate failures pass

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #340, PR #341, #332, PR #339, #337, PR #338, #326, ADR-008, PRD FR-035, §7

## What happened

PR #339 (`system.v12`, #332) needed two `Eval gate` runs, and each failed one trial on `invariant.times_in_clinic_tz_with_weekday`. Both failing sentences put a clock time in a several-day offer's lead-in, which `system.v12` tells the model not to do, and both were followed by day lines that said the same time: "Here are the times around 2:00 and 3:00 PM ET on both days:" over Wednesday, October 14 and Thursday, October 15, and "Dr. Anna Kowalski has 8:00 AM ET open every day next week." over five Monday-to-Friday lines. #337's grader accepted one family of wording for this ("every / each / all five days that week") and nothing else, so a patient who couldn't have misread either sentence still failed the gate. Nick accepted both for #339's merge and filed #340.

He settled three questions in the readiness review (round 1), accepting every recommendation, and the agent (a task worker) built them. The grader now also accepts "every day", "each day" and "all five days" followed by "next week", plus "both days" and "each of those days", each only when the same assistant text's day lines back it. "both days" needs day lines for exactly two dates, "each of those days" for at least two, and every day line must list the time. `system.v12` is byte for byte what it was.

## Why we chose what we chose

- **Add the wordings seen, not a rule that drops the list (Q-1 (c) over (a), (b) and (d)).** Keeping the list as it was (a) left both gate sentences failing. Adding only "next week" (b) fixed the second sentence and left "on both days" failing. Dropping the list (d), so that any sentence passes when every day line lists its time, would have flipped the five bare-phrase fixtures ("every day", "those days", and three more) that #337 kept failing on purpose. (c) covers both sentences and the forms the issue named, and leaves those fixtures alone.
- **"this week" stays out.** The prompt defines it as the rest of the current Monday-to-Friday week, so on a Wednesday a Monday-to-Friday backing would fail a correct "every day this week".
- **Exactly two for "both days" (Q-2 (a) over (b)).** A patient told "both days" over three listed days could misread which two are meant. "each of those days" takes any count from two up, because it doesn't claim a number.
- **The prompt doesn't change (Q-3 (a) over (b) and (c)).** #332's measured run failed this check on 0 of 15 trials, and its four lead-ins that named a time passed because day lines backed them. A new prompt version would have cost a live measurement and the version number #306, #234 and #251 are waiting on. The cost is a gap we now record in ADR-008: the grader accepts a backed lead-in in more wordings than the prompt asks for.
- **Our reading of "both must list the time" (the decision left it open).** Day lines are keyed by their heading's text, as `dayLinesBack` already does, so two headings for one date with different text are two day lines that must each list the time while counting as one date. Two headings with identical text merge into one line. The alternative was the union of times per date, which would pass a second heading that lacks the time; we judged that as wrong as a day line without the time.
- **Dates come from `headingListTimes`' key, not the heading's weekday.** Two dates on the same weekday (October 14 and 21) back "both days", because each day line carries its date. The prompt's same-weekday rule stays a prompt rule.

## What surprised us

- Both gate sentences' real day lines do back them, so both pass. The readiness review couldn't say that, because the day lines weren't in the issue; the agent read them from the gate runs' `eval-gate-results` artifacts. The reschedule sentence passes on "3:00 PM" alone, because "2:00" has no AM/PM and the grader doesn't read it.
- The gate artifact holds each trial's `events` in the scenario file, so an offline regrade works from it, but the L1 files don't, so nothing about this change can be replayed on L1 cases.

## Evidence

- Offline regrade, no model call, with a throwaway script (not committed): the two failing trials change from fail to pass and no trial changes the other way; the per-trial table and the per-file counts are on #340.
- Fixtures in `packages/evals/test/undated-times.test.ts`: each gate sentence's whole text, placed as it was in its trial, plus backed and unbacked synthetic cases for each added phrase (one, two and three dates, a day line missing the time, two headings for one date, whole-word edges). The existing fixtures keep their verdicts.
- Seen failing: the PR's `npm run mutate` table.

## What's next

- #201 gets suggested several-day lead-in eval cases; the prompt gap stays recorded in ADR-008's amendment.
