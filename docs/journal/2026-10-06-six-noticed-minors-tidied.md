# 2026-10-06 — Six "noticed" minors from the judge's PR, tidied, and a hash that pins the judge's prompt to its version

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M3
**Related:** issue #183, PR #191, PR #165 (the LLM judge, #32), issues #34 and #159

## What happened

PR #165's reviews recorded six minor findings as "noticed, optional", and they merged without a follow-up. A task worker (Claude) closed them in one PR, building against Nick's answers to the issue's readiness review:

- **de04bd8/STD-4:** the `JUDGE_DIMENSIONS` comment no longer says #32 will score every entry. It says which ones the judge scores and which report `skip`.
- **de04bd8/SMELL-104:** `isDeterministicFailure` is the one predicate behind `trialPassed` and the suite's `failedChecks`.
- **de04bd8/SMELL-105:** `isJudgedInvariant` lives beside `JUDGED_INVARIANTS`, and the two grader tests use it instead of rebuilding the check.
- **de04bd8/SMELL-207:** `calibrationStep` requires `calibration`. The repo's first `// @ts-expect-error -- …` checks it: if the field turns optional again, the directive goes unused and `npm run typecheck` fails with TS2578. typescript-eslint `strict` accepts the directive when it carries a description.
- **de04bd8/TEST-104:** `JUDGE_RUBRIC_VERSION`'s bump rule now has a test. It hashes the judge's system prompt and user message, with the version replaced by a placeholder, and compares the hash with the entry for the current version. Rewording one anchor, or moving to `judge.v2` without an entry, turns it red.
- **de04bd8/SPEC-2** needed no code. The rubric average pools every `tone` and `clarity` score, and #34 owns the choice between that and the mean of the two means. A note on #34 names both readings.

Mutation runs showed a gap in the old tests. Making a skip count as a failure (`status !== "pass"` in place of `status === "fail"`) survived the whole evals suite. A new test file, `test/trial-passed.test.ts`, kills it.

## Why we chose what we chose

These are the decisions the spec left open, each with the alternative it beat.

- **`main()` binds the narrowed arguments first.** A-5 said `main()` passes `{ ...args, calibration: args.calibration }` inside the existing `if`. Written inline in the `orUsageErrorAsync(() => …)` callback, it doesn't typecheck: TypeScript's narrowing of `args.calibration` doesn't reach into the closure. So the `if` binds `const step = { ...args, calibration: args.calibration }` and the callback passes `step`. The alternative was a non-null assertion inside the callback, which would hide the check the issue asked for.
- **One hash covers the system prompt and the user message.** The decision named both texts. We hash them joined by a separator line, with one map entry per version, instead of keeping two maps. A version is a property of the whole prompt, and one entry is one line to add when it moves.
- **The skip test went in its own file.** It tests `trialPassed` and `isDeterministicFailure` directly, in `test/trial-passed.test.ts`. The alternative was to add it to `test/graders.test.ts`, which #181 is editing at the same time.

## Evidence

- `npm run mutate` over the changed source files: 8 of 8 Vitest edits killed, plus 4 type-level edits killed by `tsc`: two for SMELL-207, and two that drop a `JUDGE_DIMENSIONS` entry the STD-4 comment names (PR #191).
- The TEST-104 test first failed on a placeholder hash, then passed with the real one: `0cebbfd5…1505` for `judge.v1`.
