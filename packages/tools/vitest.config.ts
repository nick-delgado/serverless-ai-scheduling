import { defineConfig } from "vitest/config";

// sync-start:test-time-zone (restated in the vitest.config.ts of @sched/contracts, @sched/tools and @sched/agent)
// The tests of this package run in America/Los_Angeles, not the machine's zone (UTC in CI), so they can catch date
// code that reads the local zone, but only at instants where Los Angeles and the zone the code should read disagree
// (#210). In UTC, `getUTCDay` → `getDay` in `dates.ts` (PR #208's D25) and dropping `long()`'s `timeZone: "UTC"`
// in the system prompt (P5) pass every test; in Los Angeles both fail, because it is west of UTC and puts a
// UTC-midnight date on the day before. Deleting `timeZone: CLINIC.timezone` from `displayFormatter` in `clock.ts`
// fails too, because Los Angeles isn't the clinic's zone (America/New_York). A local read at an instant where the
// zones agree, such as a `getDay` on a mid-day date, can still pass. `test.env` reaches the test workers; the root
// config's `test` options don't reach this project. zone.test.ts fails if the setting is dropped.
// sync-end:test-time-zone
export default defineConfig({
  test: {
    name: "@sched/tools",
    env: { TZ: "America/Los_Angeles" },
  },
});
