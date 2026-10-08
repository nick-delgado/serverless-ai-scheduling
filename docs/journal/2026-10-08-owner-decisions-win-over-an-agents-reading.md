# 2026-10-08 — An owner decision now wins over an agent's own reading, and a lint holds write confirmations to the full date

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #216, #72, PR #202, PR #205, PR #209, PR #211, PR #214

## What happened

Process batch 8 (`improve-agent-process`, after waves A and B) found the same cause behind five review findings: an agent read a settled owner decision, saw nearby code, an example or a check that seemed to disagree, and built its own reading instead (#202 SPEC-1 and SPEC-2, #205 SPEC-1 and SPEC-2, #214 STD-1). Batch 7 had deferred this as B7-7; Nick promoted it. Two more findings (#209 STD-1, #211 STD-3) came from the PR template and `task-workflow` step 5 disagreeing about where to list a copy of existing code. A task agent made the file changes Nick approved, building against the answers to #216's readiness review (r1/Q-1 (b), A-1 to A-9):

- **B8-5.** `task-workflow` step 4, item 1 now says that a "Decisions and clarifications" item, or an owner decision on the PR, is built exactly as written, and that a doubt goes under a new PR-template line, "Departs from or questions an owner decision", rather than into the agent's own reading.
- **B8-2.** The template's "Shared-file or contract changes" comment now asks for each copy of existing code with its source, as step 5 already did.
- **B8-1.** A new scenario-lint test (`packages/evals/test/scenarios-lint.test.ts`, "eval scenarios (write confirmations)") turns #202's decision `779e407/SPEC-1` (a), that a write confirmation quotes `start_local` in full, into a check: an L1 case whose context ends with a successful `book_appointment` or `reschedule_appointment` result must list that result's `appointment.start_local`, exactly, among its response's `contains_all` strings. Both cases on `main` that end that way (`l1-book-already-booked-confirms`, `l1-reschedule-same-slot-retry`) already did, so no scenario changed.

## Why we chose what we chose

Nick settled the open questions before work started (decision lines in #216). The choices the agent made inside them:

- **The selection test uses `expect.arrayContaining`** with the two known ids (A-1), so a selection bug fails a named test rather than leaving an empty `it.each`, and a case #201 adds is checked without editing the test.
- **The result is read through the tool's contract** (`TOOLS[tool].output.parse(result).appointment.start_local`) rather than a cast. The schema has already validated the result, so the parse can't fail on a selected case, and both write outputs share the `appointment` field.
- **The lint matches exact strings** (A-2), so an entry that only contains `start_local` inside a longer string fails, although the grader's case-insensitive substring match would accept it. One mutation shows it.

## What surprised us

- **The obvious selection mutation was an ERROR, not a KILLED row.** Inverting the write-tool filter (`if (isWriteTool(tool))`) sent non-write results into `TOOLS[tool].output.parse`, which threw while Vitest collected the tests, so `npm run mutate` reported a failed run with no failing test. The agent replaced it with a mutation that narrows the selection to `book_appointment` only, which the selection test catches.
- **Nothing else in the instructions named the template's sections in a way the change made false.** The agent searched the repository (excluding `.agents/` and the journal) for the section names and `pull_request_template`; the hits in `task-workflow` and `dev-journal` still read true (A-7).

## Evidence

- Process findings on #72: [#202](https://github.com/nick-delgado/serverless-ai-scheduling/issues/72#issuecomment-6031078746), [#205](https://github.com/nick-delgado/serverless-ai-scheduling/issues/72#issuecomment-6031952748), [#209](https://github.com/nick-delgado/serverless-ai-scheduling/issues/72#issuecomment-6040235994), [#211](https://github.com/nick-delgado/serverless-ai-scheduling/issues/72#issuecomment-6041458342), [#214](https://github.com/nick-delgado/serverless-ai-scheduling/issues/72#issuecomment-6049670597); batch 7's record, where B7-7 was deferred: [#72](https://github.com/nick-delgado/serverless-ai-scheduling/issues/72#issuecomment-6025244073). The batch 8 record wasn't posted on #72 when this was written.
- Seen failing: `npm run --silent mutate -- <edits.json> --markdown -- npx vitest run packages/evals/test/scenarios-lint.test.ts`, 5 edits, 5 killed: dropping the year from each case's `contains_all` entry, widening the reschedule case's entry to a longer string, narrowing the selection to `book_appointment`, and reading the context's first item instead of its last. The table is in the PR.

## What's next

- Step 4 item 3 still says to stop and ask when the issue conflicts with an ADR, the PRD, `packages/contracts` or a skill, which overlaps the new item 1 for a decision line; A-6 left it as it is, for a later batch.
- The lint covers L1 cases and `start_local` only (A-3): a reschedule's `previous_start_local` and the multi-turn scenarios' `response_contains_all` aren't checked.
