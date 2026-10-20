# 2026-10-19 — A line before the first lookup: one required sentence, measured on two clinic-local days

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #251, PR #354, #37, #233, #249, #234, ADR-002 (amendment of 2026-10-19), PRD NFR-001

## What happened

#37 found that the deployed chat's first visible text took 4,735 ms at p50 (NFR-001's target is 3,000 ms) because the measured turn, "Does Dr. Haddad have anything this Thursday afternoon?", made three model calls (`find_providers`, `check_availability`, the answer) and the model wrote nothing before the first two. Nick accepted the miss then. #251's readiness review (round 1) asked four questions and Nick took every recommendation, so the agent (a task worker) took the smallest change: `system.v14` makes one short line required before a reply's first tool call when that call is a lookup (`find_providers`, `check_availability`, `get_my_appointments`, `get_patient_profile`). It comes once per reply, before that first call only, and has no question mark. The rest is unchanged: a reply that calls `escalate_to_human` has no text before any call (#249), and the writes keep "nothing, or one short line". The prompt is `system.v13` renamed in place, with its tests.

## Why we chose what we chose

- **A required line, prompt only (r1/Q-1 (a)).** The line moves the first `text_delta` from model call 3 to model call 1. Skipping `find_providers` (b) leaves a fresh conversation's three calls as they were, and a preferred provider in the prompt (c) changes the measured turn's user and needs a handler change. Counting the status chip (d) is a PRD change. Docs only (e) leaves the miss.
- **Lookups only (r1/Q-2 (a)).** Requiring the line before the writes would put a sentence before a booking the patient has just confirmed, and it must never appear before `escalate_to_human` (#249). The measured turn starts with a lookup, so lookups are enough.
- **Fresh before-run, on a different day (r1/Q-4 (a)).** #37's figures are `system.v3`. The before-run is `main`'s `system.v13`, run on 2026-10-19; the after-run waits for a different clinic-local day because one user can't make 60 turns under the daily cap of 50.

## What surprised us

- **A gate run shares the quota.** The first before-run (started 11:13 UTC) lost 5 of its first 11 turns to `RATE_LIMITED`: another PR's Eval gate job started a minute after it and used the account's Bedrock quota. We stopped it, waited for the gate job to finish, and ran all 30 turns again. Its window is the one in the ADR.
- **`dev` hadn't moved since 2026-10-16.** Its last "chat turn" line was from 2026-10-14, and the stack was last updated after `system.v5` landed, so the deploy for the before-run took it from that to `system.v13`.

## Evidence

- Before (`system.v13`, `main` at `cb5ca45`, window 2026-10-19 11:25:44 to 11:35:45 UTC, no Eval gate job running): 30 `done` turns, p50 first `text_delta` 4,250 ms, p95 7,003 ms, p50 `done` 5,353 ms, p95 `done` 7,805 ms, read with ADR-002's 2026-10-14 query plus `promptVersion`.
- After (`system.v14`): 30 `done` turns, p50 first `text_delta` 2,478 ms, p95 4,453 ms, p50 `done` 5,739 ms, p95 `done` 7,261 ms (branch `feat/251-line-before-lookups` merged with `origin/main` at `ffc6e27`, `system.v14`, window 2026-10-20 10:23:17 to 10:33:21 UTC, 06:23 ET on the next clinic-local day, no Eval gate job running). Each of the 30 turns still made three model calls, and in each `firstTextMs` is within 30 ms of the first model call's `durationMs` (`llmCalls[0]`; the handler starts about 27 ms before the call), so the first text came with model call 1, not call 2 or 3. We read these timings, not the text, so "the line was written before `find_providers`" is inferred from them. That is under NFR-001's 3,000 ms, so r1/Q-3 needs no decision line.
- Tests: `packages/agent/src/prompts/system.v14.test.ts` pins the bullet and has content guards for the four lookups, once per reply, no question mark, the writes and escalation. The PR's Seen-failing table has the KILLED rows. A mutation can't show the model writes the line; only the re-measure can.

## What's next

- `dev` runs the branch's `api` until the PR merges; it goes back to `main`'s after.
- A pre-tool-line grader case belongs on #343 (A-6).
