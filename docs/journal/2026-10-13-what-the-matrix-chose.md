# 2026-10-13 — What the evals showed: fourteen cells, one near-miss, and a latency target no effort level meets

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #37, PR #252, #34, #239, #244, #245, #246, #247, #248, #249, #250, #251, #159, ADR-002, ADR-008, ADR-010, PRD §7, NFR-001, NFR-003

## What happened

M3 asked the question the whole harness was built for: which model should run the chat?
- **The run:** an agent (Claude, as #37's task worker) ran `npm run evals:matrix`. That's the six entitled profiles, with Sonnet 4.6, Nova 2 Lite and both gpt-oss models at three effort levels each: 14 cells.
- **Per cell:** the full suite, three trials per case, in both modes. The simulator was `sonnet-4.6` and the judge `haiku-4.5`.
- **Approval:** Nick approved the estimate first: $75.00, with a $112.55 cap split across five `--cells` batches.
- **Time:** it took 23 hours, from 2026-10-11 23:03Z to 2026-10-12 22:08Z. Every scenario trial's patient replies come from `sonnet-4.6`, whose account quota is 10 requests a minute, so the simulator sets the pace for every cell. A `sonnet-4.6` cell took close to three hours.
- **Cost:** $57.61. The estimate ran about 30% high ($75.00 against $57.61).

No cell met PRD §7 as the matrix scores it. One came close: `sonnet-4.6@high`.
- It met task success (92%), reliability (87%), emergency, rubric (4.89) and cost ($0.0400 per completed conversation).
- It had one safety violation: `no_hallucinated_slots` read "the latest the clinic is open is 5:00 PM ET", said while turning down an evening request, as a quoted slot.
- The agent read every flagged transcript. Four other `sonnet-4.6` violations were #239's known false positive, where the agent echoes the patient's own "Tue at 2:30" appointment. r1/A-4 had already settled that those don't count.
- The clinic's closing time was a new false-positive class (#244), and Nick counted it as one (Decision r2/M-1 (a)).
- Every other cell missed task success: `sonnet-4.6@medium` came closest at 83%, 7 points short of 90%, and every other cell missed by more (corrected 2026-10-13: 8 → 7 points, #259). The cheap models were cheap (`gpt-oss-20b` at $0.0033 per completed conversation), but completed far fewer tasks: 28 to 71% task success, against 90%.

Then NFR-001, on the deployed stack.
- **Setup:** the agent deployed the branch to `dev` and drove 30 turns of "Does Dr. Haddad have anything this Thursday afternoon?" through CloudFront with the S-2 driver, then read the handler's own "chat turn" log lines with Logs Insights.
- **At `high`:** first `text_delta` was 4,735 ms at p50, against a target of 3 s. `done` was 7,259 ms at p95, well inside 15 s.
- **At `medium`:** Nick asked for the same 30 turns, after the clinic's day rolled over so the per-patient daily cap allowed them. Medium came in at 4,102 ms. So the effort level wasn't the problem.
- **The cause:** every turn made three model calls (`find_providers`, `check_availability`, then the answer), and visible text only starts with the third. Nick kept `high` and accepted the first-text miss for now (Decision r4/N-2 (a)). The latency work is #251.

Last, the refusal fallback, which nobody had run live since PR #53.
- A new spike, `spikes/refusal-fallback/`, ran two turns through `runAgentTurn` against the in-memory clinic. In the second, a wrapper client returned a scripted refusal for the first call.
- The loop retried on `haiku-4.5` with the first turn's history, called `check_availability` and completed. It cost $0.047.
- `haiku-4.5`'s own matrix row sits beside that pair: 68% task success, 47% reliability, 17 safety violations. The PR asked whether to re-pair, as r1/Q-4 (a) required, and Nick kept `sonnet-4.6` → `haiku-4.5`: refusals are rare, and no entitled alternative has fewer than its 17.

## Why we chose what we chose

- **`sonnet-4.6` at `high`, not a new profile name.** r1/Q-5 (a): the winning level becomes the plain profile's level. So `DEFAULT_MODEL_PROFILE`, the stack parameter and the CI gate's profile name all stay `sonnet-4.6`. Only `modelFields` and the matrix's switch default move.
  - Side effect: the eval simulator builds its requests from the same profile, so it runs at `high` too.
  - Nick accepted that cost, about +$0.02 to $0.03 per Eval gate run. That's an estimate from the agent's own 16 to 29% rise, since the matrix ran the simulator at `medium`.
- **No fix round.** r1/Q-2 (a) allowed one prompt bump and a second full matrix. With `sonnet-4.6@high` qualifying once the false positive was set aside, Nick took the result rather than another day of runs.
- **The triaged failures became issues, not edits here:**
  - the two grader false positives (#244, #245);
  - two harness and adapter defects that made whole cells meaningless (#246, where Nova 2 Lite rejects `maxTokens` at `high`; #247, where `gpt-oss-20b`'s invented tool names break every later call);
  - one scenario expectation (#248);
  - two prompt behaviours (#249, #250).
- **The rubric and agreement rows.** The rubric is the pre-calibration average and agreement is pending #159 (r1/Q-6 (a)). `haiku-4.5`'s own row is self-judged.
- **The amendment's date.** ADR-002's amendment is dated 2026-10-12, the day the matrix finished and the choice was made (r2/M-1), rather than 2026-10-13, when the NFR-001 comparison, the refusal turn and Nick's r4/N-2 came in. The matrix result is what the amendment records; the later runs confirm or qualify it.

## What surprised us

- **The doubled handoff.** It survives a rule that already forbids it: `system.v3` (#233) tells the agent to write nothing announcing the handoff before `escalate_to_human`, and `sonnet-4.6` still did it in `escalate-frustration` (3/3 at `low` and `medium`, 1/3 at `high`). #249 allows a loop-level fix for that reason.
- **More effort bought reliability.** From `low` to `medium` to `high`, `sonnet-4.6` went from 80% to 83% to 92% task success, and from 8 to 3 to 1 safety violations. The agent's cost per completed conversation rose only from $0.0319 to $0.0400.
- **First-text latency is about the turn's shape, not the model's speed.** A named-provider question costs a provider lookup before the availability check, and the patient sees a status line for about 4.5 s before any words.
- **The 23 hours.** The matrix's wall-clock was set by the simulator's quota, not the models under test. The SSO session had to be renewed partway, and a later switch to the `sso-session` config gave a refreshable token.

## Evidence

The comparison table, one row per cell as `npm run evals:matrix` printed it (full suite, k=3, both modes, prompt `system.v3`, simulator `sonnet-4.6` at `medium`, judge `haiku-4.5`):

| Cell | Task success | Reliability | Safety violations | Emergency | Rubric avg | Agent $ / completed | p95 latency | Wall-clock | Meets §7 | Run cost |
|---|---|---|---|---|---|---|---|---|---|---|
| sonnet-4.6@low | 80% | 70% | 8 (l1 0, scenario 8) | l1 2/2, scenario 2/2 | 4.90 / 5 | $0.0319 | 20628 ms | 159.6 min | no | $6.26 |
| sonnet-4.6 (`medium`, then the default) | 83% | 80% | 3 (l1 0, scenario 3) | l1 2/2, scenario 2/2 | 4.92 / 5 | $0.0348 | 21023 ms | 159.8 min | no | $6.54 |
| sonnet-4.6@high | 92% | 87% | 1 (l1 0, scenario 1) | l1 2/2, scenario 2/2 | 4.89 / 5 | $0.0400 | 24744 ms | 171.0 min | no | $7.16 |
| haiku-4.5 | 68% | 47% | 17 (l1 0, scenario 17) | l1 2/2, scenario 2/2 | 4.85 / 5 | $0.0108 | 16517 ms | 115.7 min | no | $3.83 |
| nova-pro | 54% | 27% | 64 (l1 2, scenario 62) | l1 2/2, scenario 2/2 | 4.51 / 5 | $0.0186 | 7008 ms | 70.2 min | no | $4.44 |
| nova-2-lite | 28% | 10% | 22 (l1 0, scenario 22) | l1 2/2, scenario 2/2 | 4.76 / 5 | $0.0137 | 13559 ms | 85.1 min | no | $4.11 |
| nova-2-lite@medium | 31% | 17% | 27 (l1 0, scenario 27) | l1 2/2, scenario 1/2 | 4.72 / 5 | $0.0210 | 27164 ms | 112.5 min | no | $4.98 |
| nova-2-lite@high | 0% | 0% | 18 (l1 0, scenario 18) | l1 0/2, scenario 0/2 | n/a | n/a | 3507 ms | 18.2 min | no | $0.23 |
| gpt-oss-120b | 59% | 33% | 48 (l1 1, scenario 47) | l1 2/2, scenario 2/2 | 4.46 / 5 | $0.0060 | 4359 ms | 72.9 min | no | $3.31 |
| gpt-oss-120b@medium | 70% | 43% | 16 (l1 2, scenario 14) | l1 2/2, scenario 2/2 | 4.85 / 5 | $0.0069 | 6127 ms | 75.2 min | no | $3.55 |
| gpt-oss-120b@high | 71% | 47% | 11 (l1 1, scenario 10) | l1 2/2, scenario 2/2 | 4.77 / 5 | $0.0095 | 17518 ms | 97.7 min | no | $3.91 |
| gpt-oss-20b | 33% | 7% | 41 (l1 1, scenario 40) | l1 1/2, scenario 2/2 | 4.24 / 5 | $0.0033 | 2309 ms | 65.3 min | no | $2.63 |
| gpt-oss-20b@medium | 36% | 7% | 35 (l1 1, scenario 34) | l1 1/2, scenario 2/2 | 3.65 / 5 | $0.0039 | 5604 ms | 68.0 min | no | $2.79 |
| gpt-oss-20b@high | 31% | 7% | 30 (l1 2, scenario 28) | l1 2/2, scenario 2/2 | 3.83 / 5 | $0.0071 | 23996 ms | 111.8 min | no | $3.87 |

The chosen cell's exit table (`sonnet-4.6@high`, from the matrix's `--exit-report`; NFR-001 from `dev`):

| Metric | Value | Target | Verdict |
|---|---|---|---|
| Task success, scenario mode, core categories, pass@1 | 92% (book 92%, reschedule 100%, availability 94%, escalate 93%, clarify 80%) | ≥ 90% | met |
| Reliability, scenario mode, core categories, pass^3 | 87% | ≥ 80% | met |
| Safety violations, both modes | 1 (l1 0, scenario 1), the clinic-hours false positive (#244) | 0 | met by r2/M-1 (a) |
| Emergency cases pass every trial, both modes | l1 2/2, scenario 2/2 | 100% | met |
| Judge rubric average (tone, clarity), before calibration | 4.89 / 5 | ≥ 4.0 / 5 after calibration | met, pending #159 |
| Judge–human agreement | pending #159 | ≥ 80% | pending |
| Agent cost per completed conversation (NFR-003) | $0.0400 | ≤ $0.25 | met |
| NFR-001 (deployed) | first text p50 4,735 ms; `done` p95 7,259 ms | ≤ 3 s; ≤ 15 s | first text not met (accepted, r4/N-2); `done` met |

- ADR-002's 2026-10-12 amendment has the same tables, the NFR-001 measurements and the decision record. The raw results are in a secret gist (synthetic data only): https://gist.github.com/nick-delgado/e66fca6660ee5df0b404ba0d2403a506
- The results and decisions on #37:
  - the [estimate](https://github.com/nick-delgado/serverless-ai-scheduling/issues/37#issuecomment-6114885383);
  - the [matrix results](https://github.com/nick-delgado/serverless-ai-scheduling/issues/37#issuecomment-6134630889);
  - the NFR-001 [measurement](https://github.com/nick-delgado/serverless-ai-scheduling/issues/37#issuecomment-6135367443) and [comparison](https://github.com/nick-delgado/serverless-ai-scheduling/issues/37#issuecomment-6139158062).
- The refusal trace: `spikes/refusal-fallback/results/`.
- Live spend for #37 (matrix, NFR-001 turns, refusal turn and baselines) is in the PR description.

## What's next

- #251 (first-text latency); #244 and #245 (grader false positives, next to #239 and #178); #249 and #250 (prompt behaviours, with #212, #234 and #236); #246 and #247 (cells that couldn't run); #159 (calibration, which can reopen this choice).
- M4 (#43, #45) tells this story with the comparison table above.
