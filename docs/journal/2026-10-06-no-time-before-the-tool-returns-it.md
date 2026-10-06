# 2026-10-06 — No dated time before a tool returns it, and five options after several searches

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #171, PR #188, #167, #170, PR #179, #98, #107, #114, #178, #181, #34, PRD FR-030, §7

## What happened

In the first full scenario run (PR #165), `reschedule-single-appointment` failed `invariant.no_hallucinated_slots`. The Thursday afternoon search stopped at 2:00 PM (`truncated: true`), and the agent offered "Thursday, October 15 at 2:30 PM ET *(if available — let me know and I can check further)*". #167 traced the guess to a tool gap. #170 closed that gap with `start_time`. This issue fixes the behaviour that is left now that the tool can answer.

Nick ran a readiness review on #171 and accepted every recommendation. It settled two things. The fix is prompt wording only, with no code guard (r1/Q-1 (a)). And the "at most five" line that #170's reruns broke (two `start_time` searches, ten slots in one message) is fixed here too, by showing the five slots that best fit (r1/Q-2 (a)). An agent wrote the change, in the "Offering times" section of `packages/agent/src/prompts/system.v1.ts`:

- **The five-option bullet** gains one sentence. When the searches return more than `LIMITS.availabilityMaxSlots` slots that fit, show that many that best fit what the patient asked for (earliest first when nothing narrows it down), and say more times are available if they want them.
- **A new bullet after the later-times bullet.** It says never to write a date with a time no tool has returned, whether as an offer, a hedge ("if available"), a refusal or a "let me check" line (A-1). To offer a time past a search's last slot, call `check_availability` with `start_time` in the same reply before naming it. Otherwise offer only the returned slots, and when `truncated` is true say later times exist without naming one (A-2). Until a search returns a time the patient asked for, mention it without its date.
- **Two prompt-content tests** in `system.v1.test.ts` ("content guards") quote each new sentence.

The prompt keeps its name, `system.v1` (A-4), so results from before and after this change carry the same `promptVersion` but different prompt text. The `check_availability` description is unchanged (A-3), so neither the contracts snapshot nor the tools budget moves.

## Why we chose what we chose

The readiness review and its assumptions settled the route, the reach and the measurement. These are the choices the agent made where the spec was still silent:

- **A new bullet, not a longer later-times bullet.** A-2 allowed editing either line. Leaving the later-times bullet as it was keeps #170's prompt test, which quotes it, unchanged. It also keeps the "how to search again" text apart from the "what you may not write" text. The alternative, one long bullet, would have changed the sentence #170's test checks.
- **"Write a date with a time", not "mention a time".** Rule 2 already forbids mentioning any date or time no tool returned. The defect was a time attached to a date, which is what the grader pairs and what a patient reads as an offer. A-1 asks the model to repeat the patient's own time without its date ("I'll look for 2:30 PM"), so a ban on every bare time would contradict it.
- **"Say it isn't open" is in the list.** A-1 names refusals. #98 stopped the grader counting some refusals as offers, but a refusal still quotes a dated time no tool returned, and the patient can't tell that from a guess. The alternative, leaving refusals out, would have matched the grader more closely and covered less of what A-1 asks.
- **"If truncated is true, you can say there are later times."** A-2 allows saying later times exist. We tied it to `truncated`, the only signal the tool gives. Without the condition, the model could claim later times after a search that returned everything.
- **The five that "best fit", with the earliest first as the fallback.** Q-2 (a) gives the rule. The wording interpolates `LIMITS.availabilityMaxSlots` three times, as the review asked, instead of the literal 5.
- **Exact-sentence tests, one per bullet.** Each new sentence is quoted whole, so removing any clause fails a test. The mutation run below drops each clause, sentence and bullet, and swaps each limit for 6.

## What surprised us

Pending: the live runs.

## Evidence

- Mutation edits (`npm run mutate`): 14 edits to the two bullets, each a dropped clause, sentence or bullet, or a limit set to 6. All 14 were killed by the test that quotes the edited sentence. The PR lists each edit.
- `npm run lint`, `typecheck` and `npm test` pass. So do `npm run test:coverage` and `coverage:changed`.
- Live evals (`sonnet-4.6`): pending. The PR has the commands and the dry-run estimates.

## What's next

- If an after-fix trial still names a time no tool returned, r1/Q-1 says we stop and Nick chooses between more wording and a code guard issue.
- #181 stops `max_five_options` counting echoed times, and #178 checks list offers under a date heading. Until both land, the transcripts are read by hand for those two cases.
- #34: the CI gate, which this issue blocks.
