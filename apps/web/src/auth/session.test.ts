/**
 * Which Cognito pool the app's auth service uses (src/auth/session.ts): the build's IDs, else the
 * mock's on the dev server and in tests, never the mock's in production or with VITE_MOCK_API=off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetCognitoMock } from "../mocks/cognito";
import { MOCK_COGNITO_CONFIG, MOCK_PASSWORD } from "../mocks/cognitoUsers";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetCognitoMock();
});

async function signInWithAppService() {
  const { defaultAuthService } = await import("./session");
  return defaultAuthService().signIn("maria.santos", MOCK_PASSWORD);
}

describe("defaultAuthService", () => {
  it("uses the Cognito mock in development when no IDs are set", async () => {
    await expect(signInWithAppService()).resolves.toMatchObject({ ok: true });
  });

  it("doesn't fall back to the mock with VITE_MOCK_API=off", async () => {
    vi.stubEnv("VITE_MOCK_API", "off");
    await expect(signInWithAppService()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("doesn't fall back to the mock in a production build", async () => {
    vi.stubEnv("DEV", false);
    await expect(signInWithAppService()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("uses the IDs baked into the build", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_USER_POOL_ID", MOCK_COGNITO_CONFIG.userPoolId);
    vi.stubEnv("VITE_SPA_CLIENT_ID", MOCK_COGNITO_CONFIG.userPoolClientId);
    await expect(signInWithAppService()).resolves.toMatchObject({ ok: true });
  });

  it("is one service, and getIdToken reads its session", async () => {
    const { defaultAuthService, getIdToken } = await import("./session");
    expect(defaultAuthService()).toBe(defaultAuthService());
    await expect(getIdToken()).resolves.toBeUndefined();
    await defaultAuthService().signIn("maria.santos", MOCK_PASSWORD);
    await expect(getIdToken()).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });
});
