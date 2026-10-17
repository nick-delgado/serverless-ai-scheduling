# 2026-10-16 — The lead-in needed a place for the day: "that day" took `l1-offer-single-day` from 2 of 5 to 10 of 10

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #284, PR #311, #236 (PR #283), #282 (PR #292), #300 (PR #303), #299 (PR #302), ADR-008, PRD FR-030, FR-035

## What happened

Since #236, an offer lists its times under a day line ("Tuesday, October 13:"), and the line before the list names the provider without a date. When the patient names the day ("Does Dr. Lee have anything on Tuesday, October 13?"), sonnet-4.6 kept writing the date in that lead-in as well: "Dr. Priya Lee has these openings on Tuesday, October 13:", then the day line. `l1-offer-single-day` fails that reply on its date-twice check. Nick settled the direction in the readiness review: fix the prompt rather than accept the date (r1/Q-1 (a)), and move the "more times are available" remark to its own line after the list (r1/Q-3 (a)). The new prompt has to pass at least 10 trials, every one of them, with a stop after three wordings or $0.75 of live runs (r1/Q-2 (b)).

The agent (task worker) bumped the prompt, which since #299 touches only `packages/agent/src/prompts/`. We measured it as `system.v6`. #313's PR #315 then merged its own `system.v6` (the confirmed-slot rule) first, so this PR renumbered its prompt `system.v7`: #313's v6 with this PR's sentences on top. It first measured `system.v5` on `main` (`71f7035`), then tried two wordings. The first passed 2 of 5 at `0bf7154` and was ruled out. The second passed 10 of 10 at `079d339`, and then the five `l1-offer-*` cases all passed one trial each at `079d339` (r1/A-3). Live runs cost $0.2765 in total, against the $0.75 cap.

The same PR gives `l1-offer-single-day` #300's two day-line patterns (Nick's decision `fd49963/SPEC-2` on PR #303). They fail text before "Tuesday, October 13" on its line, and text after its colon. Now the case fails a reply whose only "Tuesday, October 13:" ends the lead-in, which its date-twice check passed.

## Why we chose what we chose

- **Wording 2 gives the lead-in a phrase for the day.** Every miss on `system.v5` and on wording 1 had the same shape: the example lead-in ("Dr. Lee has these openings:") with " on Tuesday, October 13" inserted. The two `system.v5` trials that passed (`71f7035`) said "openings on that day" instead. So wording 2 changed the worked example's lead-in to "Dr. Lee has these openings that day:" and ended the sentence with 'so the line before the list says "that day", not "on Tuesday, October 13"'. The alternative, Q-3 (b)'s fixed form for the lead-in ("<provider> has these openings:", nothing added), was not chosen in the review. A fixed form would also leave the model no room to refer to the day, and that need was what drove the misses.
- **Wording 1's parts stay.** "Including a day the patient named" and the example framed by the patient's question didn't fix the lead-in on their own (2 of 5 at `0bf7154`), but they still describe the case, and wording 2 was measured with them. The remark sentence worked from the first run: all 5 wording-1 trials (`0bf7154`) and all 10 wording-2 trials (`079d339`) put "More times are available later that day if you'd like." after the list, with no date (results files below).
- **The "after the list" placement went into the best-fit sentence too.** It said "say more times are available if they want them". Now it says "say after the list that more times are available", so the two sentences don't disagree on where the remark goes.
- **`packages/evals/test/l1.test.ts` changes one line.** Its "twice" reply now matches two of the case's patterns, so the grader's pinned detail lists both. That file is outside the issue's owned paths, but the new criterion's patterns make the old detail false.
- **`l1-offer-single-day` joins #300's boundary pass rows.** Those rows (no lead-in, indented day lines, spaces after the colon, CRLF line ends) must pass, so the new patterns' anchors can't be loosened unnoticed (a tightened pattern is caught by the failing rows, such as the tab row). The alternative was failing rows only, which would not show the patterns accepting a well-formed day line in this case.
- **The date-twice check stays and keeps a row of its own.** A remark after the list that names the date without its weekday ("Dr. Lee has more openings later on October 13.") fails only that check, so removing it from the YAML turns that row red.

## What surprised us

- **On `system.v5` the case passed 2 of 5 (`71f7035`), worse than v4's recorded 3 of 5.** Neither number is large enough to call v5 worse, but the "before" was clearly not luck-proof.
- **Wording 1's added sentences made the model copy the example more closely, misses included.** All five of its lead-ins began "Dr. Priya Lee has these openings", the example's words, and three of them then added " on Tuesday, October 13" (`0bf7154`, `2026-10-16T223815Z-l1-full-sonnet-4.6.json`). Making the example a closer fit for the question ("when the patient asks whether Dr. Lee has anything on Tuesday, October 13") didn't stop the model from inserting the date into the example's sentence. Once the example itself said "that day", every lead-in in both wording-2 runs said "these openings that day:".

## Evidence

These runs used this PR's prompt before the renumber, labelled `system.v6` and without #313's confirmed-slot sentences, which touch only booking calls. Gate run 6 is the first run of `system.v7`. Every run used sonnet-4.6, l1 mode, `--suite full`, `--filter l1-offer-single-day --trials 5` unless noted. Results files are under `~/.local/state/serverless-ai-scheduling/eval-results/<checkout>/`:

| Run | Prompt | Commit | Trials passed | Cost | Results file |
|---|---|---|---|---|---|
| Before (r1/A-2) | `system.v5` | `71f7035` (`main`) | 2 of 5 | $0.0378 | `main-71f7035/2026-10-16T223740Z-l1-full-sonnet-4.6.json` |
| Wording 1 | `system.v6` | `0bf7154` | 2 of 5 (ruled out) | $0.0635 | `284-offer-lead-in-no-date/2026-10-16T223815Z-l1-full-sonnet-4.6.json` |
| Wording 2, run 1 | `system.v6` | `079d339` | 5 of 5 | $0.0704 | `284-offer-lead-in-no-date/2026-10-16T224844Z-l1-full-sonnet-4.6.json` |
| Wording 2, run 2 | `system.v6` | `079d339` | 5 of 5 | $0.0495 | `284-offer-lead-in-no-date/2026-10-16T225034Z-l1-full-sonnet-4.6.json` |
| The five offer cases (r1/A-3), `--filter l1-offer- --trials 1` | `system.v6` | `079d339` | 5 of 5 cases | $0.0553 | `284-offer-lead-in-no-date/2026-10-16T225114Z-l1-full-sonnet-4.6.json` |

- Wording 2 on `l1-offer-single-day`: 10 of 10 at `079d339` (the two 5-trial runs), and 1 of 1 more in the five-case run at `079d339`. All 10 trials of the two 5-trial runs have "Tuesday, October 13:" alone on its line. The case's two day-line patterns, in effect at `0bf7154` and later, grade that.
- Live spend: $0.2765 of the $0.75 cap. The Eval gate's CI runs are not counted.
- The prompt guards and the case's patterns were each seen failing with `npm run mutate`: see the PR's table.
- Eval gate on PR #311, smoke suite in both modes:
  - Run 1 ([38978666937](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38978666937), `7868fbb`): passed, 0 regressions, 0 safety violations.
  - Run 2 ([38980920697](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38980920697), `bdf5e29`): failed with three safety violations on `book-derm-next-week-afternoon`. The agent confirmed Dr. Okafor at 1:00 PM and then booked the 12:00 PM slot's ID, #313's wrong-`slot_id` defect. The run overlapped #308's run and was throttled 38 times. Nick accepted it as not caused by this wording ([decision on #284](https://github.com/nick-delgado/serverless-ai-scheduling/issues/284#issuecomment-6227566579)).
  - Run 3 ([38985215001](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38985215001), `31b3655`): passed, 0 regressions, 0 safety violations.
  - Run 4 ([38986746344](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38986746344), `42793cb`): passed, 0 regressions, 0 safety violations.
  - Run 5 ([38991073276](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38991073276), `75b1bea`): passed the check with 0 safety violations, but `clarify-vague-request` regressed in scenario mode (`trajectory.max_questions_per_turn`, `invariant.one_question_at_a_time`: two questions in one reply). With run 2's case, that makes two different regressed scenario cases, so Nick accepted it in its own line as model variance, tracked by #314 ([decision on #284](https://github.com/nick-delgado/serverless-ai-scheduling/issues/284#issuecomment-6228329557)).
  - Run 6, on the head after the renumber to `system.v7`: its result is in the PR.

## What's next

- #314: `clarify-vague-request`'s two-question replies, the case behind gate run 5's regression. (#313's tool-level guard against run 2's wrong-slot booking merged in PR #315.)
- #293, #234 and #251 take `system.v8` and later, and keep this bullet's "that day" example unless they measure a better one. **Later (2026-10-17):** #314 took `system.v8`, so they take `system.v9` and later; see [Options go inside the one question](2026-10-17-options-go-inside-the-one-question.md).
