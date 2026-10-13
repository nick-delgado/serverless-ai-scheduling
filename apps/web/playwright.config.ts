/**
 * The end-to-end journeys against the deployed `e2e` env (#40, M3-05): `npm run e2e -w apps/web`, after
 * `apps/web/e2e/reseed.sh`. The runbook's E2E section (docs/runbooks/aws-setup.md) has the whole procedure.
 *
 * - One reseed per run, then the projects one after another (`workers: 1`) and no retries: a retried booking would
 *   find the first attempt's appointment, and FR-031's "repeating a booking confirms it" would let a broken run pass
 *   (r1/Q-1 (a)). Re-run a failed run from the reseed.
 * - Order: login and login → book on Chromium, WebKit and Firefox (NFR-006), each browser booking a different provider,
 *   then reschedule and escalation on Chromium (`chromium-last`, r1/A-4).
 * - Specs are `*.e2e.ts`, so Vitest never collects them, and its `*.test.ts` helper tests never run here. The FR-010
 *   measurement against `dev` has its own config (`e2e/fr010.config.ts`).
 * - Output (results, traces, screenshots) goes outside the checkout, under `$RUNNER_TEMP` or the OS temp directory,
 *   so `scripts/deploy-web.sh` still sees a clean tree (r1/A-5). CI keeps no trace or screenshot (r1/A-6); the log is
 *   the list reporter, each turn's tools, and the cost line `e2e/cost-reporter.ts` ends it with.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env.CI);
const here = decodeURIComponent(new URL(".", import.meta.url).pathname);

/** Login and login → book: every browser. */
const EVERY_BROWSER = /\/0[12]-[a-z-]+\.e2e\.ts$/;
/** Reschedule and escalation: Chromium only, after the bookings. */
const CHROMIUM_ONLY = /\/0[34]-[a-z-]+\.e2e\.ts$/;

export default defineConfig({
  testDir: join(here, "e2e"),
  testMatch: "**/*.e2e.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: ci,
  // A scripted write is up to six turns of up to 90 s each (support/chat.ts).
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  outputDir: join(process.env.RUNNER_TEMP ?? tmpdir(), "sched-e2e", "test-results"),
  reporter: [["list"], [join(here, "e2e", "cost-reporter.ts")]],
  globalSetup: join(here, "e2e", "global-setup.ts"),
  use: {
    trace: ci ? "off" : "retain-on-failure",
    screenshot: ci ? "off" : "only-on-failure",
    video: "off",
    // The typewriter shows each reply at once, so a turn ends when its stream does.
    reducedMotion: "reduce",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "chromium", testMatch: EVERY_BROWSER, use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", testMatch: EVERY_BROWSER, use: { ...devices["Desktop Safari"] } },
    { name: "firefox", testMatch: EVERY_BROWSER, use: { ...devices["Desktop Firefox"] } },
    { name: "chromium-last", testMatch: CHROMIUM_ONLY, use: { ...devices["Desktop Chrome"] } },
  ],
});
