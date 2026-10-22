# 2026-10-22 — An hours remark and a one-day closing question are not offers, so the weekday check stops asking for a weekday on them

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #360, #345, #337, #340, #320, #361, #363, ADR-008, PRD FR-035, PRD §7

## What happened

#345's exit run failed `invariant.times_in_clinic_tz_with_weekday` on 8 trials in 6 cases, the largest single cause of its §7 misses. The check is not safety-tagged, but a miss fails the trial. When the agent read the eight texts whole, five patterns showed, and about half of the failing sentences were not offers at all: "The latest slot each day is 4:30 PM ET, since the clinic closes at 5:00 PM…" (three trials of `availability-weekend-after-hours`), "…between 8:00 AM and 5:00 PM ET" (`escalate-frustration`), and a closing question "Would 3:00 PM ET with Dr. Alvarez work…" under the only day line (`book-provider-not-accepting`). Nick settled each pattern in #360's readiness review (round 1) and accepted every recommendation, so no prompt option was chosen and `system.v15` stays byte for byte.

The agent changed `packages/evals/src/graders/text.ts` in three places, each a private predicate that `unclaimedTimeLacks` reads: `hoursRemark`, `oneDateBack` and a "between … and" reading of a range start. `RANGE_END`, `pairsAndLaterTimes`, `slotMentions`, `dateTimeMentions` and `namesClinicHours` are untouched, because `no_hallucinated_slots` (a safety check) reads them. The ADR-008 amendment of 2026-10-22 records it.

## Why we chose what we chose

The bullets say Nick where the answer is his (#360, round 1); the rest is the agent's.

- **An hours remark needs ET, not a weekday (Nick, r1/Q-1 (a)).** The alternatives were to drop ET as well for 8:00 AM and 5:00 PM after a clinic-hours lead (b), a stronger prompt example (c), and no change (d). (b) would have let "closes at 5:00 PM" pass with no timezone, which is the one thing FR-035 still wants from an hours fact; (c) costs a prompt bump and an eval gate for a sentence that is a remark about the clinic. The 4:30 PM time is computed from `CLINIC.closeHour` and `CLINIC.visitMinutes`, not written in, so a change of hours moves it.
- **A one-date text needs no weekday for a time its day line lists (Nick, r1/Q-3 (a)).** The alternative (b) was to limit it to a closing question after the last day line; (a) also lets a lead-in such as "Dr. Alvarez has 3:00 PM ET open:" over the same single day line pass, since the day line names the day either way.
- **"between 8:00 AM and 5:00 PM ET" is a range (Nick, r1/Q-4 (a)),** in `unclaimedTimeLacks`, not in `RANGE_END`, so the slot check still reads "9:00 AM and 11:30 AM" as two slots.
- **The two several-day sentences and the held appointment's pair keep failing (Nick, r1/Q-2 (a), r1/Q-5 (a)).** They are model misses against `system.v15`'s rule, listed here instead of fixed: "(3:30, 4:00, and 4:30 PM ET each day)", "4:30 PM ET open on multiple days:" and a Wednesday 48 characters before "October 7 at 4:00 PM ET".
- **The agent followed the spec's wording where it weakens an old pin.** "A one-date text needs no weekday in any sentence" also accepts a list line under a heading with no date ("Tuesday:") when the other day line lists that time. `l1-offer-multi-day` with a heading missing used to fail on both its contains check and this one, and now fails on the contains check alone; the pin in `offer-format.test.ts` and five pins in `undated-times.test.ts` that read "one date fails" were updated, each saying #360. A narrower rule (a closing question or a lead-in only) would have kept them; that is Nick's call if he wants it.

## What surprised us

- **Fixing the first sentence moved the failure to the second.** In `availability-weekend-after-hours`, trials 1 and 3 still fail after the change: "since the clinic closes at 5:00 PM and visits are 30 minutes" has no ET (as Nick's decision predicted), and the same replies' "Here are the available 4:30 PM ET slots…" and "Dr. Elena Alvarez has 4:30 PM ET open on multiple days:" are lead-ins over several dates. The fixtures assert every sentence a trial fails on, not only the first the verdict names.
- **"Between 8:00 AM and noon ET" still gets its ET.** "noon" is not a clock time, so the start has no range end; but the 16-character window after "8:00 AM" reaches "ET" anyway, so it fails on the weekday only. The rejection the spec lists is for the weekday, not ET.

## Evidence

- The eight trials' whole texts, with each verdict and every failing sentence, are in `packages/evals/test/undated-times.test.ts`. The offline regrade of #345's results file (a throwaway script, not committed) and the mutation table are in the PR description for the commit it names; the live k=3 run of the six cases is the PR's last step.
