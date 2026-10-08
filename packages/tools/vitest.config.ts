import { defineConfig } from "vitest/config";

// The tests of this package run in America/Los_Angeles, not the machine's zone (UTC in CI), so a date bug that
// reads the local zone fails a check (#210). In UTC, `getUTCDay` → `getDay` in `dates.ts` (PR #208's D25) and
// dropping `long()`'s `timeZone: "UTC"` in the system prompt (P5) pass every test. The zone is west of UTC, so a
// UTC-midnight date lands on the day before, and it isn't the clinic's (America/New_York), so code that falls back
// to the machine's zone where it should use the clinic's (such as `displayFormatter` in `clock.ts`) fails too.
// `test.env` reaches the test workers; the root config's `test` options don't reach this project. zone.test.ts
// fails if the setting is dropped.
export default defineConfig({
  test: {
    name: "@sched/tools",
    env: { TZ: "America/Los_Angeles" },
  },
});
