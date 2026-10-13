// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { appUrl, assertWritableEnv, baseUrlFor, E2E_PATIENT, e2eEnv, fixtureLogin } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("e2eEnv", () => {
  it("defaults to e2e and takes E2E_ENV", () => {
    vi.stubEnv("E2E_ENV", undefined);
    expect(e2eEnv()).toBe("e2e");
    vi.stubEnv("E2E_ENV", "pr40");
    expect(e2eEnv()).toBe("pr40");
  });

  it("refuses a name deploy.sh wouldn't accept", () => {
    vi.stubEnv("E2E_ENV", "E2E; rm");
    expect(() => e2eEnv()).toThrow("invalid E2E_ENV: E2E; rm");
  });
});

describe("assertWritableEnv", () => {
  it("refuses the shared dev and demo envs", () => {
    expect(() => assertWritableEnv("dev")).toThrow("don't run against the shared 'dev' env");
    expect(() => assertWritableEnv("demo")).toThrow("don't run against the shared 'demo' env");
  });

  it("allows e2e and other envs", () => {
    expect(() => assertWritableEnv("e2e")).not.toThrow();
    expect(() => assertWritableEnv("pr40")).not.toThrow();
  });
});

describe("URLs", () => {
  it("takes E2E_BASE_URL without a trailing slash, before SSM", async () => {
    vi.stubEnv("E2E_BASE_URL", "https://example.test//");
    await expect(baseUrlFor("e2e")).resolves.toBe("https://example.test");
  });

  it("builds app URLs from E2E_BASE_URL, and refuses without it", () => {
    vi.stubEnv("E2E_BASE_URL", "https://example.test");
    expect(appUrl("/chat")).toBe("https://example.test/chat");
    vi.stubEnv("E2E_BASE_URL", "");
    expect(() => appUrl("/chat")).toThrow("E2E_BASE_URL is not set");
  });
});

describe("the E2E patient", () => {
  it("is Sofia (r1/Q-1 (a))", () => {
    expect(E2E_PATIENT).toBe("pat-sofia");
  });

  it("signs in as <first>.<last> with DEMO_PASSWORD_<FIRST> from the environment first", () => {
    vi.stubEnv("DEMO_PASSWORD_SOFIA", "Synthetic-Password-1");
    expect(fixtureLogin("pat-sofia")).toEqual({
      username: "sofia.marquez",
      password: "Synthetic-Password-1",
    });
  });
});
