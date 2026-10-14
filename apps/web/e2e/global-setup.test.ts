// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import globalSetup from "./global-setup";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-e2e-setup-test-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("globalSetup", () => {
  it.each(["dev", "demo"])("refuses the shared %s env before any AWS call", async (env) => {
    vi.stubEnv("E2E_ENV", env);
    // No base URL, so the next step would read SSM: with a profile that exists nowhere, any AWS call fails first
    // with a credentials error instead of the refusal, and before reaching the network.
    vi.stubEnv("E2E_BASE_URL", undefined);
    vi.stubEnv("AWS_PROFILE", "sched-e2e-test-no-such-profile");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_CONFIG_FILE", join(dir, "config"));
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", join(dir, "credentials"));
    vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);
    vi.stubEnv("AWS_SESSION_TOKEN", undefined);
    vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
    await expect(globalSetup()).rejects.toThrow(`they don't run against the shared '${env}' env`);
  });
});
