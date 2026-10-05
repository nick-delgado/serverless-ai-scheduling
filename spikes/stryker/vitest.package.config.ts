import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Stryker runs one package's Vitest project (readiness review A-2), not the root `test.projects` set: this config
// points Vitest's root at the package named by STRYKER_PACKAGE (e.g. `packages/tools`). Packages here have no
// Vitest config of their own, so the defaults the root project set gives them apply unchanged.
const pkg = process.env.STRYKER_PACKAGE;
if (!pkg) throw new Error("Set STRYKER_PACKAGE to the package to test, e.g. packages/tools");

export default defineConfig({
  test: { root: fileURLToPath(new URL(`../../${pkg}`, import.meta.url)) },
});
