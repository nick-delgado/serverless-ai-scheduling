import { defineConfig } from "vitest/config";

// Each workspace folder is its own Vitest project, so `npm test` at the root runs everything
// and `npm test -w <package>` runs one package.
// Coverage options only take effect in the root config. `npm run test:coverage` writes
// coverage/coverage-final.json, which `npm run coverage:changed` checks against a PR's added lines (#140).
export default defineConfig({
  test: {
    projects: ["packages/*", "services/*", "apps/*", "scripts"],
    coverage: {
      provider: "v8",
      include: [
        "packages/*/src/**/*.{ts,tsx}",
        "services/*/src/**/*.{ts,tsx}",
        "apps/*/src/**/*.{ts,tsx}",
        "scripts/*.ts",
      ],
      exclude: ["**/*.test.*", "**/*.d.ts"],
      reporter: ["json", "text-summary"],
      reportsDirectory: "coverage",
    },
  },
});
