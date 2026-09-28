import { defineConfig } from "vitest/config";

// Each workspace folder is its own Vitest project, so `npm test` at the root runs everything
// and `npm test -w <package>` runs one package.
export default defineConfig({
  test: {
    projects: ["packages/*", "services/*", "apps/*"],
  },
});
