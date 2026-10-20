# 2026-10-16 — The derm case's Monday bookings were the patient's idea: our scenario told it to want "sooner"

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #301, PR #307, #306, #293, PRD FR-030, FR-041, ADR-008

## What happened

`book-derm-next-week-afternoon` is a smoke scenario, so every gated PR runs it. It failed four Eval gate runs of three PRs on `end_state.appointment`: twice "weekday is Mon" ([38934082494](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38934082494), [38955590583](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38955590583)) and twice "local date 2026-10-08 is outside 2026-10-12..2026-10-16" ([38958895946](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38958895946), [38964960833](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38964960833)). None of those PRs touched the agent's behaviour, and each run counted as the one regressed case a passing gate accepts (FR-041).

The issue guessed the simulated patient never said "Tuesday or Thursday", since that preference lives only in `hidden_facts`. The readiness review read the gate artifacts and found something else, and the task agent checked its table against the same artifacts ([AC1 comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/301#issuecomment-6225400522)). In all four failing runs the patient revealed its held Tue Oct 13 2:30 PM visit with Dr. Lee and asked for something *before* it: "Even earlier that week?", "anything on monday the 12th or sooner", "like Thu the 8th or sooner", "anything sooner, like Thu the 8th?". Then it confirmed the date it had asked for. It had named Tue/Thu in three of the four. The agent did what the patient asked.

The pull came from our own scenario. Its `already_has` said "does not want to move it, wants a second look sooner if possible". With the expectation (next week, Tue or Thu, after 12:00), "sooner" than Tue Oct 13 2:30 PM leaves exactly one passing window: Tue Oct 13, 12:00 to 2:30 PM. The simulator, an LLM, read "sooner" more broadly: in the readiness review's nine sampled gate runs, the patient asked for a time before the held visit in five, and four of those five failed. Nick chose to delete the clause (r1/Q-1 (a)): `already_has` now reads "a Lee appointment Tue Oct 13 at 2:30 PM; does not want to move it". The goal, `flexible_days` and the expectation are unchanged, so the case still checks that "next week" means Oct 12 to 16 (FR-030), and the held visit can still come up.

Then the task agent ran the case five times on the new YAML (`60a2d64`), as Nick approved. Every trial booked Thursday, Oct 15, between 1:00 and 3:00 PM, and none asked for a time before the held visit; one mentioned the visit and asked about Thursday instead. `end_state.appointment` passed in all five. One trial still failed, on a different check: its lead-in "Here are the available times on Thursday, October 15 at 1:00 PM or later:" has no "ET", so `times_in_clinic_tz_with_weekday` failed. That is #293's open pattern (a time outside an offer list), not this case's. By the issue's rule (r1/A-4) a failed check is a failed trial, so the run is 4 of 5, not the 5 of 5 AC3 asked for, and the [measured rate went to Nick](https://github.com/nick-delgado/serverless-ai-scheduling/issues/301#issuecomment-6225676656) for a decision. This PR's Eval gate trial ([run 38974499903](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38974499903)) booked Thursday too and failed the same "ET" check. Nick [accepted 4 of 5](https://github.com/nick-delgado/serverless-ai-scheduling/issues/301#issuecomment-6226112808): `end_state.appointment` passed 6 of 6 trials after the change, and both failures are #293's check, which #301 doesn't own.

## Why we chose what we chose

Nick picked the option the readiness review recommended; these are its alternatives, as settled on #301:
- **Delete the "sooner" clause (chosen)** over rewording the goal to name Tue/Thu: the patient already named Tue/Thu in 8 of the review's 9 sampled runs, so the preference didn't need to move into the goal.
- Over **bounding "sooner"** ("an earlier time that same Tuesday afternoon, otherwise Thursday"): that keeps the tension but still leaves an LLM to decide what "earlier" means, and it had stretched "sooner" to Oct 8 and Oct 12.
- Over **widening the expectation** to accept this week and Mondays: the case would stop checking FR-030's "next week", a check the agent has failed before.
- **AC3: Nick accepted 4 of 5** ([decision](https://github.com/nick-delgado/serverless-ai-scheduling/issues/301#issuecomment-6226112808)) over holding the PR for 5 of 5: the case's own check, `end_state.appointment`, passed in 6 of 6 trials after the change (`60a2d64`: the five local trials and gate run [38974499903](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38974499903)), and both failed trials failed #293's missing-"ET" check, which this issue doesn't own.

No test or `npm run mutate` table comes with the change (r1/A-5): the YAML isn't a source file for the coverage or seen-failing gates, and no test reads the clause. The live run is the evidence.

## What surprised us

- The hypothesis in the issue was wrong in three of the four failing runs: the patient *had* said Tue/Thu. The failure wasn't a missing constraint but a conflicting one we wrote.
- Reading the transcripts turned up a real agent miss that didn't cause these failures: twice, when the patient asked for earlier dates, the agent dropped the patient's afternoon preference and offered 8:00 to 9:30 AM (38955590583 turn 4, 38958895946 turn 2). That's filed as #306.

## Evidence

- The four failing runs, their results files, patient turns and costs: [#301's AC1 comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/301#issuecomment-6225400522).
- Before-rate: 5 of the readiness review's 9 sampled gate runs passed the case (#301 r1/A-3). At that rate, an unchanged case passes 5 of 5 about 5% of the time.
- After, at `60a2d64`: `packages/evals/results/2026-10-16T220144Z-scenario-full-sonnet-4.6.json` (git-ignored; a copy is kept outside the checkout), `--trials 5 --max-cost 2.5`. 4 of 5 trials pass; `end_state.appointment` passes in 5 of 5 (all Thu Oct 15, 1:00 to 3:00 PM). Trial 5 fails `invariant.times_in_clinic_tz_with_weekday`: "October 15 at 1:00 PM" lacks a weekday or ET. Cost $0.84: agent $0.772 (simulator $0.150 of it) plus judge $0.067; 0 retries, 0 throttled.
- The dry run estimated $0.31 for the same command; the run cost 2.7× that.
- An attempt a minute earlier (`2026-10-16T220048Z-scenario-full-sonnet-4.6.json`) ran without `AWS_PROFILE=sched-dev`: every trial errored on missing credentials before any model call, at $0. It isn't counted.
- This PR's Eval gate runs are reported in PR #307.

## What's next

- #306: carry the patient's time of day into searches over other dates. **Later (2026-10-19):** `system.v15` (#306) took its version and keeps the patient's stated time of day on every later search; see [The patient's time of day stays on every search until they change it in words](2026-10-19-the-patients-time-of-day-stays-until-they-change-it.md).
- #293: the missing "ET" outside offer lists, which failed this run's fifth trial. **Later (2026-10-17):** #293 took `system.v9` (PR #319); see [Every undated time still left out "ET"](2026-10-17-every-undated-time-still-left-out-et.md).
