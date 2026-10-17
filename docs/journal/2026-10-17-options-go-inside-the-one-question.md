# 2026-10-17 — Options go inside the one question: `system.v8` passes `clarify-vague-request`'s question checks 5 of 5, and two of five opening replies joined two details with "and"

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #314, PR #318, #249 (PR #250), #284 (PR #311), #301 (PR #307), #316 (PR #317), #293, #201, ADR-008, PRD §5 conversation rules 1 and 2, FR-041

## What happened

The smoke scenario `clarify-vague-request` allows one `?` per assistant message (`max_questions_per_turn: 1`). On three Eval gate runs in two days it failed `trajectory.max_questions_per_turn` and `invariant.one_question_at_a_time`, each time on another PR whose change didn't touch the rule. Nick accepted the first two as within FR-041's one case per mode, on #301 and on #284. The agent (task worker) read the failing turns from the gate artifacts and posted them on #314 ([comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/314#issuecomment-6233881477)). They come in two shapes:

- **Shape 1:** an open question, then a second one that restates it or lists its options. On `system.v5` the reply was "When would you like to come in? Any day or time that works best for you?" ([38979873746](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38979873746)). On #284's branch prompt it was "When would you like to come in? This week, next week, or a specific day?" ([38991073276](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38991073276)).
- **Shape 2:** two different details asked at once. On `system.v7` the opening reply was "What is the visit for, James? And do you have a preferred provider or specialty?" ([39023823567](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/39023823567)).

Nick settled the direction in the readiness review. It is a prompt change, not a change to the case (r1/Q-1 (a)), and it covers both shapes (Q-2 (a)). It rewords the general one-question bullet, so the new wording governs every reply (Q-3 (a)). It is measured on the two question checks over 5 trials (Q-4 (b)). The agent bumped the prompt to `system.v8`, inside `packages/agent/src/prompts/` only. The bullet now says:

- never follow a question with a second one that restates it or lists its options;
- put any options inside the one question, for example "When would you like to come in: this week, next week, or a specific day?";
- when several details are missing, each one after the first waits for a later reply, after the patient answers.

A content guard quotes the bullet, and a second checks that the example has one run of `?`. Both were seen failing with `npm run mutate` (the PR's table).

The 5-trial run at `b3791ec` passed both question checks in every trial, and every other check too. One trial each of the three scenario cases outside the smoke suite that check one question also passed.

## Why we chose what we chose

- **One worked example, for shape 1 only (r1/A-4).** It is the issue's own sentence. #284's worked example ("that day") is what moved `l1-offer-single-day`, so an example was the likeliest lever. Shape 2 got no example. The bullet says the second detail waits, and an example of what not to ask could have been copied too.
- **"Never follow a question with a second one" rather than "no second question".** The multi-request bullet already says "no second question after it" for a message with several requests. The general bullet needed to name the two things the failing replies did: restate the question, and list its options. It had to do that without forbidding a single question that offers alternatives. Run 38991073276's turn-2 reply, "Do you have a preference for one of those, or a specific provider you'd like to see?", is that kind of question and passed.
- **"Each other detail waits for a later reply, after the patient answers; don't add it as a second question."** This replaces "and the rest in later turns", which v5 to v7 already had when shape 2 happened. The new sentence says when a later detail may be asked (after the answer), not only that it comes later.
- **The second guard uses its own regex rather than `countQuestions`.** `@sched/evals` depends on `@sched/agent`, so the prompt test can't import the grader. The guard restates the grader's rule: runs of `?`, one run allowed.

## What surprised us

- **The model kept the example's words but not its colon.** In four of the five trials, the time question was "When would you like to come in — this week, next week, or a specific day?" That is the example word for word, with an em dash where the example has a colon. In the fifth, the patient's "go ahead and search" made the question unnecessary. A colon and a dash both keep it to one `?`, which is all the graders count.
- **Two of five opening replies joined two details with "and", in one question.** "What is the visit for, and do you have a preferred provider or specialty?" (trials 1 and 4, `2026-10-17T133231Z`). That is run 39023823567's shape 2 with the `?` between its two halves removed. It passes both checks, because they count question marks. But it asks for what the new sentence says should wait. The other three trials asked only for the reason. It isn't new. In the review round we went back to the same 59 gate trials behind the before rate, and the joined form was already the usual opening there: 35 of 59 opening replies on `system.v1` to `v7`, and 9 of 25 on `v5` to `v7` (the agent counted replies containing ", and do you have a [preferred] provider"). It never counted as a miss, because it has one `?`. So the run is consistent with shape 1 handled, and shape 2 is only partly handled, since the graders can't see the joined form. Nick chose to track it on #201 (decision `d0433ae/SPEC-2` (b) on PR #318): the opening-turn L1 case there is to carry a `format_must_match_none` pattern that fails a second detail joined into the one question ([comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/201#issuecomment-6235233900)).
- **The dry-run estimate was 2.7× low for the 5-trial run.** It estimated $0.3064 and the run cost $0.8295 with the judge, the top of the 1.7 to 2.7× range seen before. The 3-case run was 1.9× low. An earlier attempt at the 5-trial run hit an expired SSO token on every simulator call. It cost $0 and was re-run once Nick had signed in again.

## Evidence

Both runs were at `b3791ec` with `system.v8`, on sonnet-4.6, in scenario mode with `--suite full`. The simulator was `sim.v1` on sonnet-4.6 and the judge was `judge.v1` on haiku-4.5. The results files are under `~/.local/state/serverless-ai-scheduling/eval-results/314-one-question-per-reply/`.

| Run | Cases | Both question checks | Every check | Cost (agent + simulator; judge) | Results file |
|---|---|---|---|---|---|
| AC 4 (r1/Q-4 (b)), `--trials 5 --max-cost 1.50` | `clarify-vague-request` | 5 of 5 trials | 5 of 5 trials | $0.7635; $0.0660 | `2026-10-17T133231Z-scenario-full-sonnet-4.6.json` |
| r1/Q-3 (a), `--trials 1 --max-cost 1.00` | `clarify-next-friday`, `clarify-two-requests-one-message`, `reschedule-which-appointment` | 3 of 3 cases | 3 of 3 cases | $0.3253; $0.0191 | `2026-10-17T134327Z-scenario-full-sonnet-4.6.json` |

- **Before rate (r1/A-3).** We counted over the 64 unexpired `eval-gate-results` artifacts, created 2026-10-09T12:46Z to 2026-10-17T11:17Z; 59 of them have scenario results.
  - This case passed 34 of 34 trials on `system.v1` to `v4`.
  - It passed 21 of 24 graded trials on `system.v5` to `v7`, plus 1 `error`. Each of the three misses is one of the replies above, and each failed only the two question checks.
  - That makes 87.5%, and at that rate an unchanged prompt passes 5 of 5 about half the time (0.875^5 ≈ 0.51). So the 5 of 5 run is consistent with the fix, not proof of it.
- **Live spend.** The two runs cost $1.1739, judge included, against the $2.50 the two approved `--max-cost` values allowed.
- **The PR's own Eval gate runs** are extra after-data, and their results are in the PR.

## What's next

- #201: an L1 case for each failing turn ([suggestion](https://github.com/nick-delgado/serverless-ai-scheduling/issues/201#issuecomment-6234699697)). The opening-turn case carries a `format_must_match_none` pattern for a second detail joined into the one question, as seen in two of this run's five opening replies ([addition](https://github.com/nick-delgado/serverless-ai-scheduling/issues/201#issuecomment-6235233900)). If it fails, #201 records it as a finding, and a prompt fix gets its own issue.
- #293 (the missing "ET"), #234 and #251 take `system.v9` and later. They keep this bullet and its example unless they measure a better one. **Later (2026-10-17):** #293 took `system.v9` (PR #319), so #234 and #251 take `system.v10` and later; see [Every undated time still left out "ET"](2026-10-17-every-undated-time-still-left-out-et.md).
