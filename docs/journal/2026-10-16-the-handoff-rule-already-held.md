# 2026-10-16 — The handoff rule we tightened already held, and the two-request case now fails on "ET", not on questions

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #249, #250, PR #294, #37, #233, #236, #293, ADR-008, PRD FR-034, FR-031, FR-032

## What happened

#37's model matrix found two prompt behaviours on `system.v3`. In `escalate-frustration` the agent wrote "Let me connect you with our front desk right away." before calling `escalate_to_human`, then gave the escalation message after it, so the handoff appeared twice (#249). In `clarify-two-requests-one-message` it asked two or three questions in one reply when the patient brought two requests (#250). Nick folded #250 into #249 so that one version bump covers both. A readiness review (r1) settled the route: prompt only (Q-1 (a)), a rule for questions in several-request messages (Q-2 (a)), and a run of both cases at k=3 with one rewording allowed before a stop (Q-3 (a)).

An agent (Claude, as #249's task worker) made `system.v5` (commit `3b013f7`). Nick approved each run's estimate on #249 before it started. In order:

- **The before run, on `system.v4` (`fc3736b`, results `2026-10-16T153658Z-scenario-full-sonnet-4.6.json`).** `escalate-frustration` passed in all three trials, and none of the three escalation turns had text before the call. `clarify-two-requests-one-message` passed one trial of three: one failure asked "Is that the one you'd like to move? And what's the new appointment you'd like to add?", and the other wrote a time without a weekday or ET.
- **The after run, on `system.v5` (`3b013f7`, results `2026-10-16T155141Z-scenario-full-sonnet-4.6.json`).** `escalate-frustration` again passed three of three, each escalation turn starting with the call. `clarify-two-requests-one-message` passed two of three. Its failing trial worked on the requests one at a time, as the new rule asks, but asked two questions about the first one: "Is that the one you'd like to move? If so, when would you like to reschedule it to?"
- **The one rewording Q-3 allows (`6663515`)** forbids a second question about the same request, and the agent re-ran that case alone (results `2026-10-16T160517Z-scenario-full-sonnet-4.6.json`). It passed one trial of three. Neither failing trial broke a question check (`max_questions_per_turn`, `one_question_at_a_time`). Both failed `times_in_clinic_tz_with_weekday` on a time written without "ET": "Let me check Dr. Haddad's availability for Thursday, October 22 at 10:00 AM right away." and "Would Monday, October 19 at 10:00 AM work, or would you like to see other days?"

The agent stopped there and posted the failing turns on #249. Nick chose option (a): #250's criterion counts as met for its own rule, and the time-format failure is #293, outside this issue.

The two rules, as `system.v5` (`6663515`) words them:

- **Escalating to a person:** "Give it once in that reply. A reply that calls escalate_to_human has no text before the call: no apology, no acknowledgement, and no line about what you are about to do. Call the tool first; once it succeeds, put any apology or acknowledgement in one short sentence right before that message." The general rule for text before a tool call gains "before escalate_to_human, write nothing".
- **How to run the conversation:** "When a message brings two or more scheduling requests (availability, booking, rescheduling, or a lookup of their own appointments), work on them one at a time, in the order the patient gave them. Ask at most one question in that reply, about the request you are working on: one question mark in total, not one per request, and no second question after it, not even about the same request ("If so, when would you like it?"); the next question waits for the patient's answer. You may still call tools for any of the requests in that reply. Say in a statement, not a question, that you will turn to the other request next. The emergency rule, the rule for a patient who names themselves as someone else, and the out-of-scope rule still act in that same reply."

## Why we chose what we chose

The readiness review settled the route and the scope of both rules (Q-1 (a), Q-2 (a), Q-3 (a)). Nick chose prompt only because the loop route (drop a response's text when `escalate_to_human` succeeds, and send `text_reset`) would amend ADR-007 and the `ChatTextResetEvent` contract, rest on an unchecked Bedrock behaviour (replaying a response without its text block), and make a line appear and vanish on screen. The decisions the spec left open:

- **The escalation rule names what can't come before the call** ("no apology, no acknowledgement, and no line about what you are about to do") instead of v4's "nothing that announces the handoff". The v3 failure was an apology and an announcement in one line, and "announces" left the model to judge which part was allowed. The alternative was to keep "announces" and only add where the apology goes.
- **The apology gets a place: one short sentence after the call, right before the message.** The case's judge reads empathy, so forbidding the apology outright would trade one failure for another.
- **The general pre-tool rule points at the exception** ("before escalate_to_human, write nothing (see "Escalating to a person")") rather than leaving two rules that disagree. The alternative was to state the exception only in the escalation section.
- **The several-requests rule is a new bullet next to the one-question rule**, not a rewrite of it, so the single-request wording and its tests stay as they were. The policy table's "One question at a time" row becomes "One question at a time; several requests one at a time" and keeps its scenario IDs (A-8).
- **The rewording targets the failing turn's shape, a second question about the same request ("If so, …?")**, not the multi-request part, which had held. The alternative was a general "never two question marks", which the one-question rule above already says and the model had broken anyway, so the example was the new information.
- **The rule stays worded as a statement about the other request** ("Say in a statement, not a question, that you will turn to the other request next") because the graders count runs of `?` per message.

## What surprised us

- **The failure #249 was filed for didn't reproduce on `system.v4`.** `escalate-frustration` passed three of three before any change (`fc3736b`, results `2026-10-16T153658Z-scenario-full-sonnet-4.6.json`), against one of three on `system.v3` in #37. `system.v4`'s offer-format work (#236) didn't touch the escalation rule, so k=3 is too few trials to tell a fix from luck. Our runs show the new rule holds (three of three again, `3b013f7`, results `2026-10-16T155141Z-scenario-full-sonnet-4.6.json`), but they can't show it fixing a failure we reproduced.
- **The two-request case moved its failure, not only its pass rate.** The before run's failures were one question failure and one time-format failure (`fc3736b`, results `2026-10-16T153658Z-scenario-full-sonnet-4.6.json`). After the rewording, both failures were time-format ones and no question failure remained (`6663515`, results `2026-10-16T160517Z-scenario-full-sonnet-4.6.json`). The missing "ET" is in a line before a tool call or in a closing question, the places the offer format (#236) doesn't govern. That is #293.
- **The dry-run estimate was low.** The before run cost $0.63 against a $0.37 dry-run (`fc3736b`, results `2026-10-16T153658Z-scenario-full-sonnet-4.6.json`, with 18 throttled retries). The estimate doesn't model the simulator's longer conversations or the retries.
- **A judge score dipped with no rule broken.** In the after run, the judge gave `escalate-frustration` trial 1 a 3/5 on `no_claim_to_be_human` (`3b013f7`, results `2026-10-16T155141Z-scenario-full-sonnet-4.6.json`), for the same apology-then-message reply the other trials got 5/5 for. Judge scores sit beside a trial's status and don't change it, and calibration (#159) hasn't measured how far to trust them.
- **The first attempt at the before run never reached Bedrock.** It started without `AWS_PROFILE=sched-dev`, and every trial failed with `CredentialsProviderError` at $0 (`fc3736b`, results `2026-10-16T153500Z-scenario-full-sonnet-4.6.json`). The `run-evals` skill does set the profile in its examples. The agent missed it, stopped, and asked before running again.

## Evidence

| Run | Prompt (commit) | Results file | `escalate-frustration` | `clarify-two-requests-one-message` | Cost (agent + simulator, judge) |
|---|---|---|---|---|---|
| Before | `system.v4` (`fc3736b`) | `2026-10-16T153658Z-scenario-full-sonnet-4.6.json` | 3/3 | 1/3 (one question failure, one time-format failure) | $0.5825 + $0.0429 = $0.63 |
| After | `system.v5` (`3b013f7`) | `2026-10-16T155141Z-scenario-full-sonnet-4.6.json` | 3/3 | 2/3 (the failing trial had both) | $0.5834 + $0.0457 = $0.63 |
| Re-run, after the rewording | `system.v5` (`6663515`) | `2026-10-16T160517Z-scenario-full-sonnet-4.6.json` | not run | 1/3 (two time-format failures, no question failure) | $0.4735 + $0.0279 = $0.50 |

- The command for each run: `AWS_PROFILE=sched-dev npm run evals -- --mode scenario --suite full --ids <cases> --profile sonnet-4.6 --trials 3`, effort `high`. The results files are git-ignored, with copies under the checkout's state directory.
- The live spend for the three runs (`fc3736b`, `3b013f7` and `6663515`, results files above) was $1.76. The first attempt, without credentials (`fc3736b`, `2026-10-16T153500Z-scenario-full-sonnet-4.6.json`), cost $0.
- The estimates, the failing turns and Nick's decision are on #249.
- The content guards in `packages/agent/src/prompts/system.v5.test.ts` quote both rules. The PR's Seen-failing table shows each break of them, including v4's escalation sentence restored and "one at a time" removed.
- The Eval gate's smoke comparison is in the PR.

## What's next

- #293: times written outside an offer list (pre-tool lines, closing questions) leave out "ET".
- #251 (first-text latency) and #234 bump the prompt next, from `system.v5`. **Later (2026-10-16):** #284 took `system.v6` first (PR #311), touching only `prompts/` for the bump; see [the "that day" entry](2026-10-16-the-lead-in-says-that-day.md).
