/**
 * FR-010's greeting measurement (#40, r1/Q-6 (a)): Chromium, against `dev` (`FR010_ENV`), read-only. Page loads call
 * only `POST /api/session`, which reads; no turn is sent, nothing is seeded, nothing costs Bedrock time. Run it locally
 * as `sched-dev`: `npm run e2e:fr010 -w apps/web`. Not part of `e2e.yml`.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  // Relative to this file.
  testDir: ".",
  testMatch: "fr010.greeting.ts",
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  outputDir: join(tmpdir(), "sched-e2e-fr010", "test-results"),
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], trace: "off", screenshot: "off", video: "off" },
});
