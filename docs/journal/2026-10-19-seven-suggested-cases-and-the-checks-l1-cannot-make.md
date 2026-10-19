# 2026-10-19 — Seven suggested eval cases, and the pre-tool checks L1 can't make

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #201, PR #344, #343, ADR-008 (amendment of 2026-10-19), PRD FR-030, FR-032, FR-035, #314, #293, #282, #320, #337, #332, #234, #340, #251

## What happened

#201 was the standing place where PRs listed eval cases they couldn't add themselves. It had three comments, which the readiness review (round 1) folded into seven cases: S1 to S3 from PR #318 (one question per clarifying reply, #314) and T1 to T4 from PR #319 (a time written without a date still carries ET, #293). Nick accepted every recommendation, so the agent (a task worker) added them as L1 files, none tagged `smoke`, so the gate and `baselines/sonnet-4.6.json` don't move:

- `l1-opening-turn-one-detail` (S1), `l1-reason-known-one-question` (S2) and `l1-time-missing-one-question` (S3): one question mark at most. S1 adds two `format_must_match_none` patterns for a question that names both the visit's reason and a provider or specialty.
- `l1-move-same-time-next-thursday` (T1) and `l1-move-any-day-week-after-at-ten` (T2): the expected `check_availability` call, plus the opt-in ET check on the line before it.
- `l1-offer-single-slot-lead-in` (T3) and `l1-offer-closing-question-no-date` (T4): a single-slot offer's lead-in and an offer's closing question, with `format_must_match_none` patterns for the date and the month-day.

`suggested-cases.test.ts` grades each pattern against the replies the decisions quote, and the other checks of each case against calls and replies that should pass or fail. A successor issue, #343, takes over as the collection point, and the `add-agent-tool` skill and `docs/backlog.md` point to it.

## Why we chose what we chose

- **T1 and T2 get the checks L1 makes beside a call, not a `format_*` key (r1/Q-1 (a)).** L1 reads `format_*` keys, `contains_*` and `max_questions` only when the model made no tool call. #319's suggestion graded the pre-tool line with a pattern that would never have run. The cases keep what does run: the call, the opted-in `times_in_clinic_tz_with_weekday` (ET on every time) and the always-on `no_hallucinated_slots`. The alternatives were dropping both cases until a grader change (b) and widening this issue to change L1's grading of six existing cases (c); (c) would have reopened #282's decision and collided with #340's work on the same grader package. The cost is a known gap: a month-day with no time after it, or no text before the call at all, goes ungraded. The ADR-008 amendment says #201 covers only the closing-question half of #320's gap, and the grader change is #346.
- **S1's patterns need both the reason and a provider in one question sentence (r1/Q-2 (a)).** Any question naming a provider (b) would fail "Which provider would you like to see?", which `system.v12` allows; "and"/"or" joins (c) would fail "Is it a new problem or a follow-up?". The known gap: a second detail that is a time ("What is the visit for, and when works?") passes.
- **Count only for S2 and S3 (r1/Q-3 (a)).** Both quoted failures had two question marks. Requiring a topic (b) would fail the "or when" reply the comment allows.
- **A clock of Mon Oct 12 for T1 to T4 (r1/Q-4 (a)).** At the standard clock "next Thursday" is Oct 15, pat-walter's own appointment, so T1 would have asked to move a visit onto itself.
- **T2 is written to `system.v12`, not to "weekdays only" (r1/A-2).** #332 changed the rule after #319's comment: a pre-tool line needs ET only. The case expects one search with `start_time: "10:00"` on one day of the week, because `args_subset` takes any one call that fits.
- **No ET regex in any case (r1/A-3).** Since #320 the invariant grades every clock time, so a second pattern would report one miss twice.
- **`forbid_tools` on S1, T1 and T2 is the agent's own choice.** No decision set them; S1 copies S2's and S3's list from r1/Q-3 (a), and T1 and T2 forbid `reschedule_appointment` and `book_appointment`, since the next action is a search. The alternative, no list, would let a reply that writes first still pass.
- **A test file for the patterns (r1/Q-6 (a)).** A YAML pattern with a typo still loads and passes every live trial. The test runs `gradeL1` on the quoted rejects and accepts, and each edit that breaks a pattern is a red row in the PR's table.

## What surprised us

- **Breaking a pattern didn't always fail the test that named it.** Some of the first mutations survived or failed the wrong test: dropping a pattern's closing `\?` made the pattern match a bare day line, so the accepts failed, not the rejects, and a "reason" synonym hid a broken "visit" alternative until a reject sentence used only "visit". Accept cases that are statements, not questions, were what pinned the `\?`.
- **The T2 provider was untested at first.** Dropping `provider_id` from the expected call survived until a test sent a search with no provider.

## Evidence

- Code: the commit that adds the seven cases, `suggested-cases.test.ts` and the doc repoints. The Seen-failing table is in the PR body.
- Live run at `81b608a` (`sonnet-4.6`, `system.v13`, 1 trial each): all seven cases passed, no safety flag, about $0.06. Results file `2026-10-19T113553Z-l1-full-sonnet-4.6.json`, posted on #201. One trial each, so T1 and T2 may have passed with no text before the call.

## What's next

- A grader change for L1 `format_*` keys beside a tool call (#346), which would let T1 and T2 carry a month-day pattern.
- A case listed on #201 after work started goes to #343.
