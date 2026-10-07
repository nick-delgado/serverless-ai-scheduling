# 2026-10-07 — The prompt and the tools now read the clinic calendar from one place, and two of its mutations only fail outside UTC

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #114, PR #208, PR #102 (finding `7e3e8bd/SMELL-1`), #34, PRD FR-030, FR-035

## What happened
The system prompt's "Today / This week / Next week" lines (PR #102) had their own copy of the clinic-date arithmetic, because `@sched/agent` can't import `@sched/tools`, where `clinicDateOf`, `addDays` and `weekdayOf` lived. Two copies of "which day is it at the clinic" can drift, and a wrong weekday in the prompt becomes a wrong booking.

A task agent moved those helpers, with `toZonedParts`, `parseIsoDate` and `toInstantMs`, into a new module in `@sched/contracts` (`packages/contracts/src/dates.ts`), which both packages import. `packages/tools/src/clock.ts` imports them for its UTC conversions and re-exports the public ones, so no caller changed an import. The prompt now gets today from `clinicDateOf`, the week's Monday from `addDays(today, -((weekdayOf(today) + 6) % 7))`, and the other days from `addDays`, as Nick settled in r1/Q-3.

Before any source changed, the agent committed tests that pin the full rendered `dynamic` text at six instants around the Nov 1, 2026 DST change, and the full `stable` text as an inline snapshot (r1/Q-1), and saw them pass on the old code (commit `2bd5f2b`). They pass unchanged after the move, so the prompt is byte-identical, and the eval run is replaced by that proof (r1/Q-2).

## Why we chose what we chose
Decisions the spec left open, each with the alternative it beat:

- **The module is `dates.ts`.** The issue's file name was a suggestion; `dates` matches the one-word names of the other contracts modules (`clinic`, `tools`, `trace`).
- **The prompt's `long()` and `iso` now take an `IsoDate` string,** through a one-line `utcDate()` that turns it into a UTC-midnight `Date` for `Intl`. The alternative was converting the helpers' strings back into `Date` values at each call site. `iso` stays as r1/Q-3 says, though it now round-trips a string that is already ISO; dropping it would be a prompt-code change the decision didn't ask for.
- **`clock.ts` re-exports by name** (`export { addDays, clinicDateOf, toZonedParts, weekdayOf, type ZonedParts } from "@sched/contracts"`), rather than `export *`, which would have leaked the newly public `parseIsoDate` and `toInstantMs` through `@sched/tools`. A tools test checks each re-export is the contracts function itself, and the round-trip test annotates a value as `ZonedParts`, so dropping the type re-export fails `typecheck`.
- **The contracts test goes beyond the two moved tests.** It also pins every field of `toZonedParts`, `parseIsoDate`'s rejection, `toInstantMs`, and `clinicDateOf`'s zero-padding and time-zone argument, so a break of any moved line fails in `@sched/contracts` itself rather than only through a tools test.
- **Two `??` fallbacks** (`parts.weekday ?? ""`, `y ?? NaN`) carry `v8 ignore` hints with reasons: they exist for the index types and no input reaches them.

## What surprised us
Two of the 37 edits we used to break the code survive in a UTC process: `getUTCDay()` to `getDay()` in `weekdayOf`, and removing `timeZone: "UTC"` from the prompt's `long()`. Every `Date` they touch is UTC midnight, so in UTC local and UTC readings agree. With `TZ=America/New_York` both fail the tests (readiness assumption A-3 predicted this). CI runs in UTC, so CI alone would not catch either regression.

One line no edit can break on Node 24: the `% 24` in `toZonedParts`, which guards ICU builds that render midnight as `24` even with `hourCycle: "h23"`. Node 24's ICU never does.

## Evidence
- Pins committed first and seen passing on the unchanged prompt: `2bd5f2b`.
- `TZ=America/New_York npm run mutate` over the three test files: 37 edits, 37 killed. The same command with `TZ=UTC` and `--only D25,P5`: 2 survived. Tables in the PR.
- `npm test`: 116 files, 2876 tests passing; `coverage:changed` and `dup:changed` clean.

## What's next
- #34's CI eval gate should add `packages/contracts/src/dates.ts` to its path list: a change there moves the prompt's date lines and the tools' clinic days without touching either package.
- Consider running the date tests in CI under `TZ=America/New_York` as well, so the two UTC-blind mutations above are caught there.
