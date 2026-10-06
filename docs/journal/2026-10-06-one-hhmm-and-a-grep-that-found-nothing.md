# 2026-10-06 — One HH:MM schema, and an acceptance grep that would have passed with nothing moved

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #182, PR #189, PR #179 (finding 4a6f31c/SMELL-1, decision (b)), issue #170

## What happened

PR #179 gave `check_availability` a `start_time` field with its own `HH:MM` regex, and the eval scenarios already had an identical `HhMm` schema with a different message. Nick moved the duplication into this follow-up. A task worker (Claude) moved `HhMm` into `packages/contracts/src/primitives.ts`, next to `IsoDate`, and pointed both users at it. The scenario schema has no regex of its own now. A bad scenario time (`local_time: "9:30"`) reports the message the model sees for a bad `start_time`, `Expected a time as HH:MM (24-hour)`, where it used to say `Expected "HH:MM" (24-hour)`.

Nothing the model sees changed. The contracts snapshot test passed without `-u`, which confirmed assumption A-2: a primitive with no `.describe()` gives the same `pattern` and `description` and no `$defs`. So, per decision r1/Q-2, no eval smoke run.

## Why we chose what we chose

These are the decisions the spec left open, each with the alternative it beat.

- **The acceptance criterion's grep, as written, finds nothing, on `main` too.** `git grep -n -F '2[0-3]' -- 'packages/*/src'` prints no lines before or after this change, because a pathspec with a wildcard is matched against whole paths, so `packages/*/src` only matches a file named `src`. We ran it as `-- ':(glob)packages/*/src/**'`, which reaches the files under each `src`. On `main` that prints three code lines (the regex in `tools.ts` and in `evals/src/schema.ts`, plus the snapshot's `pattern`); on the branch it prints the primitive and the snapshot line. Using the literal command would have been "passing" a check that can't fail. In review, Nick decided (a097390/SPEC-1, option (a), [comment](https://github.com/nick-delgado/serverless-ai-scheduling/pull/189#issuecomment-6022398705)) that the `:(glob)` search meets acceptance criterion 4, and the orchestrator corrected the criterion's command in issue #182 to that form.
- **The model-visible message is pinned in `@sched/contracts`, not through the tool registry.** The test parses a bad `start_time` with `CheckAvailabilityInput` and checks the issue at path `start_time`. The registry's `INVALID_INPUT` text is built from those issue messages (`packages/tools/src/registry.ts`), but its test lives in `packages/tools`, outside the owned paths. That test only checks the message prefix, so it would not have caught a changed message either.
- **The evals file's seen-failing edit re-adds a local copy.** The scenario loader test imports helpers that load every real scenario file at import time. So any edit that makes `HhMm` reject good times, or leaves it undefined, crashes the whole file, and `npm run mutate` reports ERROR, not KILLED. The edit that counts is the one this issue removed: drop `HhMm` from the `@sched/contracts` import and define it again with the old message. The new loader test goes red.

## What's next

- Nothing for this issue. Other format strings (`YYYY-MM-DDTHH:MM` in ids, the 12-hour transcript parsers) aren't copies of this format and stay where they are (assumption A-5).
