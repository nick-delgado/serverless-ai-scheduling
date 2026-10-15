import { defineConfig } from "vitest/config";

// Each workspace folder is its own Vitest project, so `npm test` at the root runs everything
// and `npm test -w <package>` runs one package.
// Coverage options only take effect in the root config. `npm run test:coverage` writes
// coverage/coverage-final.json, which `npm run coverage:changed` checks against a PR's added lines (#140).
// The source files coverage collects. scripts/coverage-changed.ts imports these too, to check every added
// source line for an ignore hint without a reason, including in a file the coverage JSON leaves out, and
// scripts/pr-evidence.ts and scripts/mutate-suggest.ts build on them. The test helpers in scripts/test/ and the
// E2E support code in apps/*/e2e/ count since #265 (B10-3); the Playwright specs don't, since they run only
// against a deployed env: `*.e2e.ts`, and the FR-010 measurement, whose name lacks the suffix (r1/Q-5 (b)).
export const COVERAGE_INCLUDE = [
  "packages/*/src/**/*.{ts,tsx}",
  "services/*/src/**/*.{ts,tsx}",
  "apps/*/src/**/*.{ts,tsx}",
  "scripts/*.ts",
  "scripts/test/*.ts",
  "apps/*/e2e/**/*.ts",
];
export const COVERAGE_EXCLUDE = ["**/*.test.*", "**/*.d.ts", "**/*.e2e.ts", "apps/web/e2e/fr010.greeting.ts"];

export default defineConfig({
  test: {
    projects: ["packages/*", "services/*", "apps/*", "scripts"],
    coverage: {
      provider: "v8",
      include: COVERAGE_INCLUDE,
      exclude: COVERAGE_EXCLUDE,
      reporter: ["json", "text-summary"],
      reportsDirectory: "coverage",
    },
  },
});
