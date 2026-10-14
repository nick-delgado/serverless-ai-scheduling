// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import globalSetup from "./global-setup";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("globalSetup", () => {
  it.each(["dev", "demo"])("refuses the shared %s env before any AWS call", async (env) => {
    vi.stubEnv("E2E_ENV", env);
    vi.stubEnv("E2E_BASE_URL", "https://example.test");
    await expect(globalSetup()).rejects.toThrow(`they don't run against the shared '${env}' env`);
  });
});
