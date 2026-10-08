# 2026-10-08 — The date tests now run in Los Angeles, because UTC and the clinic's zone each hid a date bug we knew of

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #210, PR #220, PR #208 (#114)

## What happened

PR #208 found two breaks of the date code that every test passes in UTC: D25 (`getUTCDay` → `getDay` in `weekdayOf`, `packages/contracts/src/dates.ts`) and P5 (dropping `long()`'s `timeZone: "UTC"` in `packages/agent/src/prompts/system.v1.ts`). Both read a UTC-midnight `Date`, so in a UTC process the local and the UTC reading agree. CI runs in UTC, so CI couldn't catch either; Nick deferred the fix to #210.

The readiness review of #210 pointed out that the issue's example zone, the clinic's own `America/New_York`, trades one blind spot for another: with the process in the clinic's zone, deleting `timeZone: CLINIC.timezone,` from `displayFormatter` (`packages/tools/src/clock.ts`) formats clinic times correctly by accident, and the test that catches it in UTC passes. Nick chose `America/Los_Angeles` (r1/Q-1 (a)): west of UTC, so a UTC-midnight date lands on the day before, and not the clinic's zone, so a fallback to the machine's zone is three hours off.

A task agent gave `@sched/contracts`, `@sched/tools` and `@sched/agent` each a `vitest.config.ts` that sets `test.env: { TZ: "America/Los_Angeles" }`, and a `zone.test.ts` guard that fails if the setting is dropped (r1/Q-2 (a)). The setting lives in the projects, not in a CI step, so `npm test`, `npm test -w`, `npm run mutate` and CI's `npm run test:coverage` all run these tests in the same zone. No test needed fixing or pinning: all 818 tests of the three projects passed in Los Angeles on the first run.

## Why we chose what we chose

The zone and the mechanism were Nick's (r1/Q-1, r1/Q-2). The spec left these to the agent:

- **`test.env` in a per-package config, not the root config or `process.env.TZ`.** Vitest 5 resolves a directory project without a config file using `configFile: false`, so root `test` options never reach it (assumption A-1), and a top-level `process.env.TZ = ...` in a config runs in Vitest's main process and would reach every project, including `services/api`, `packages/evals`, `apps/web` and `scripts`, which #210 keeps out of scope. Before building on it, the agent checked that `test.env` reaches the workers: D25 was KILLED with no `TZ=` prefix, and again with `TZ=UTC`, the zone CI's machine has.
- **The guard reads `Intl.DateTimeFormat().resolvedOptions().timeZone`**, one per package, so removing one package's setting fails that package's guard, not a shared one.
- **The zone string is written in each config**, not imported from `CLINIC.timezone`, because it is deliberately not the clinic's.

## What surprised us

Nick's machine runs in `America/New_York`, the clinic's zone. So before this change local runs and CI each had a different blind spot: locally D25 and P5 failed (as PR #208's `TZ=America/New_York` table shows) but a machine-zone fallback like the `clock.ts` deletion formats 14:00Z as the expected "10:00 AM" there (the readiness review's `node` check; we didn't run that edit in New York), while CI had the opposite blind spot. Neither environment saw both. Now the zone comes from the test config, so a local run and a CI run of these projects see the same thing, and the `TZ=UTC` control run below shows the machine's zone no longer matters.

## Evidence

- Seen failing, `npm run mutate -- edits.json --markdown -- npx vitest run <dates.test.ts, clock.test.ts, system.v1.test.ts and the three zone.test.ts files>`, no `TZ=` prefix: 6 edits, 6 killed. D25 and P5 (copied from PR #208), the `clock.ts` `timeZone: CLINIC.timezone,` deletion, and deleting each package config's `TZ` entry, each killed by that package's guard. The table is in the PR body.
- The same command for D25, P5 and the `clock.ts` deletion with `TZ=UTC` in front: 3 edits, 3 killed.
- `TZ=UTC npx vitest run --project @sched/contracts --project @sched/tools --project @sched/agent`: 34 files, 818 tests passed, including the three guards.

## What's next

- `services/api`, `packages/evals`, `apps/web` and `scripts` still run in the machine's zone; if a date bug turns up there, the same per-package config extends to them.
