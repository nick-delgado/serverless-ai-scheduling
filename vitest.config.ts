import { defineConfig } from "vitest/config";

// Each workspace folder is its own Vitest project, so `npm test` at the root runs everything
// and `npm test -w <package>` runs one package.
// Coverage options only take effect in the root config. `npm run test:coverage` writes
// coverage/coverage-final.json, which `npm run coverage:changed` checks against a PR's added lines (#140).
// The source files coverage collects. scripts/coverage-changed.ts imports these too, to check every added
// source line for an ignore hint without a reason, including in a file the coverage JSON leaves out.
export const COVERAGE_INCLUDE = [
  "packages/*/src/**/*.{ts,tsx}",
  "services/*/src/**/*.{ts,tsx}",
  "apps/*/src/**/*.{ts,tsx}",
  "scripts/*.ts",
];
export const COVERAGE_EXCLUDE = ["**/*.test.*", "**/*.d.ts"];

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
