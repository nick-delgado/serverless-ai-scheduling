/**
 * The Amplify auth service against the Cognito mock (src/mocks/cognito.ts): real Amplify code, real
 * SRP math, fake pool. Tokens live in jsdom's local storage, as in the browser.
 */
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cognitoMockStats, configureCognitoMock, expireCognitoSessions } from "../mocks/cognito";
import { MOCK_COGNITO_CONFIG, MOCK_PASSWORD } from "../mocks/cognitoUsers";
import { server } from "../mocks/node";
import { type AuthService, createAmplifyAuthService } from "./authService";

// Each sign-in runs SRP's 3072-bit math on both sides (~0.2 s alone); allow for a busy CI machine.
vi.setConfig({ testTimeout: 20_000 });

let auth: AuthService;

/** Maria as the service reports her: her username and her Cognito `sub`. */
const MARIA = { username: "maria.santos", sub: "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e" };

beforeEach(() => {
  localStorage.clear();
  auth = createAmplifyAuthService(() => MOCK_COGNITO_CONFIG);
});

afterEach(() => vi.restoreAllMocks());

/** A JWT's payload (the mock's tokens are unsigned). */
function claims(token: string | undefined): Record<string, unknown> {
  const payload = token?.split(".")[1] ?? "";
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
}

describe("signIn", () => {
  it("signs in with the right password and returns the user", async () => {
    await expect(auth.signIn("maria.santos", MOCK_PASSWORD)).resolves.toEqual({
      ok: true,
      user: MARIA,
    });
    await expect(auth.currentUser()).resolves.toEqual(MARIA);
  });

  it("trims spaces around the username", async () => {
    await expect(auth.signIn("  maria.santos ", MOCK_PASSWORD)).resolves.toMatchObject({ ok: true });
  });

  it("reports a wrong password and an unknown user the same way", async () => {
    const wrong = await auth.signIn("maria.santos", "Not-the-password-1");
    const unknown = await auth.signIn("nobody.here", MOCK_PASSWORD);
    expect(wrong).toEqual({ ok: false, reason: "credentials" });
    expect(unknown).toEqual(wrong);
    await expect(auth.currentUser()).resolves.toBeUndefined();
  });

  it("signs in whatever the username's case (the pool is case-insensitive)", async () => {
    await expect(auth.signIn("Maria.Santos", MOCK_PASSWORD)).resolves.toEqual({
      ok: true,
      user: MARIA,
    });
  });

  it.each([
    ["password", "maria.santos", ""],
    ["username", " ", MOCK_PASSWORD],
  ])("reports an empty %s as credentials, without calling Cognito", async (_, username, password) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(auth.signIn(username, password)).resolves.toEqual({ ok: false, reason: "credentials" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports UserNotFoundException like a wrong password, if the pool ever sends it", async () => {
    server.use(
      http.post("https://cognito-idp.us-east-1.amazonaws.com/", () =>
        HttpResponse.json(
          { __type: "UserNotFoundException", message: "User does not exist." },
          { status: 400, headers: { "x-amzn-errortype": "UserNotFoundException:" } },
        ),
      ),
    );
    await expect(auth.signIn("nobody.here", MOCK_PASSWORD)).resolves.toEqual({
      ok: false,
      reason: "credentials",
    });
  });

  it("reports a user who must set a new password as unsupported, and stays signed out", async () => {
    await expect(auth.signIn("new.patient", MOCK_PASSWORD)).resolves.toEqual({
      ok: false,
      reason: "unsupported",
    });
    await expect(auth.currentUser()).resolves.toBeUndefined();
    // The half-finished sign-in is dropped: the next attempt starts over.
    await expect(auth.signIn("maria.santos", MOCK_PASSWORD)).resolves.toMatchObject({ ok: true });
  });

  it.each(["network", "internal"] as const)("reports a %s failure as unavailable", async (fault) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureCognitoMock({ fault });
    await expect(auth.signIn("maria.santos", MOCK_PASSWORD)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("reports missing Cognito settings as unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unconfigured = createAmplifyAuthService(() => {
      throw new Error("Sign-in is not configured");
    });
    await expect(unconfigured.signIn("maria.santos", MOCK_PASSWORD)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(unconfigured.currentUser()).resolves.toBeUndefined();
    await expect(unconfigured.getIdToken()).resolves.toBeUndefined();
  });
});

describe("configuration", () => {
  it("resolves the Cognito settings once, on first use", async () => {
    const config = vi.fn(() => MOCK_COGNITO_CONFIG);
    const service = createAmplifyAuthService(config);
    expect(config).not.toHaveBeenCalled();
    await service.currentUser();
    await service.signIn("maria.santos", MOCK_PASSWORD);
    await service.getIdToken();
    await service.signOut();
    expect(config).toHaveBeenCalledTimes(1);
  });
});

describe("getIdToken", () => {
  it("is undefined when signed out", async () => {
    await expect(auth.getIdToken()).resolves.toBeUndefined();
  });

  it("returns the ID token (not the access token) while the session is fresh, without a refresh", async () => {
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    const token = await auth.getIdToken();
    expect(claims(token)).toMatchObject({ token_use: "id", "cognito:username": "maria.santos" });
    await expect(auth.getIdToken()).resolves.toBe(token);
    expect(cognitoMockStats().refreshes).toBe(0);
  });

  it("refreshes an expiring token silently", async () => {
    configureCognitoMock({ tokenLifetimeSeconds: 1 }); // inside Amplify's 5 s expiry margin
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    configureCognitoMock({ tokenLifetimeSeconds: 3600 });
    const token = await auth.getIdToken();
    expect(cognitoMockStats().refreshes).toBeGreaterThan(0);
    // A token from the refresh: the one from sign-in expired a second after it was issued.
    expect(claims(token)).toMatchObject({ token_use: "id", "cognito:username": "maria.santos" });
    expect(Number(claims(token).exp) * 1000).toBeGreaterThan(Date.now() + 3_000_000);
    await expect(auth.currentUser()).resolves.toEqual(MARIA);
  });

  it("is undefined, and the session is cleared, when the refresh token no longer works", async () => {
    configureCognitoMock({ tokenLifetimeSeconds: 1 });
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    expireCognitoSessions();
    await expect(auth.getIdToken()).resolves.toBeUndefined();
    await expect(auth.currentUser()).resolves.toBeUndefined();
  });

  it("rejects on a transient failure and keeps the session", async () => {
    configureCognitoMock({ tokenLifetimeSeconds: 1 });
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    configureCognitoMock({ fault: "internal" });
    await expect(auth.getIdToken()).rejects.toThrow();
    configureCognitoMock({ fault: "none" });
    await expect(auth.currentUser()).resolves.toEqual(MARIA);
  });

  it("signs in again over a stored session it couldn't refresh", async () => {
    configureCognitoMock({ tokenLifetimeSeconds: 1 });
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    configureCognitoMock({ fault: "internal" });
    await expect(auth.currentUser()).resolves.toBeUndefined();
    configureCognitoMock({ fault: "none", tokenLifetimeSeconds: 3600 });
    await expect(auth.signIn("maria.santos", MOCK_PASSWORD)).resolves.toMatchObject({ ok: true });
    expect(claims(await auth.getIdToken())).toMatchObject({ token_use: "id" });
  });
});

describe("session lifetime", () => {
  it("survives a reload: a fresh copy of the app finds the stored session", async () => {
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    vi.resetModules();
    const fresh = await import("./authService");
    const reloaded = fresh.createAmplifyAuthService(() => MOCK_COGNITO_CONFIG);
    await expect(reloaded.currentUser()).resolves.toEqual(MARIA);
    expect(claims(await reloaded.getIdToken())).toMatchObject({ token_use: "id" });
  });

  it("configures Amplify before signing out, even as its first call", async () => {
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    // Amplify is global: leave it configured for another app client, whose storage keys are different.
    const other = createAmplifyAuthService(() => ({
      ...MOCK_COGNITO_CONFIG,
      userPoolClientId: "otherclient",
    }));
    await other.currentUser();
    const fresh = createAmplifyAuthService(() => MOCK_COGNITO_CONFIG);
    await fresh.signOut();
    expect(cognitoMockStats()).toMatchObject({ revocations: 1, liveSessions: 0 });
    await expect(fresh.currentUser()).resolves.toBeUndefined();
  });

  it("signOut revokes the refresh token and clears the stored session", async () => {
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    expect(cognitoMockStats().liveSessions).toBe(1);
    await auth.signOut();
    expect(cognitoMockStats()).toMatchObject({ revocations: 1, liveSessions: 0 });
    await expect(auth.currentUser()).resolves.toBeUndefined();
    await expect(auth.getIdToken()).resolves.toBeUndefined();
    expect(Object.keys(localStorage).filter((key) => key.includes("idToken"))).toEqual([]);
  });

  it("tells listeners when a failed refresh ends the session, and stops when unsubscribed", async () => {
    configureCognitoMock({ tokenLifetimeSeconds: 1 });
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    const listener = vi.fn();
    const stop = auth.onChange(listener);
    expireCognitoSessions();
    await auth.getIdToken();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    await auth.signOut();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tells listeners about a sign-out", async () => {
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    const listener = vi.fn();
    auth.onChange(listener);
    await auth.signOut();
    expect(listener).toHaveBeenCalled();
  });
});

/**
 * The Identity Pool (S6-02, #29): voice's `getAwsCredentials` exchanges the ID token through Cognito
 * Identity, which this file stands in for; `getIdToken` never needs it (r1/Q-1 (a)).
 */
describe("Identity Pool credentials", () => {
  const IDENTITY_ENDPOINT = "https://cognito-identity.us-east-1.amazonaws.com/";
  const IDENTITY_POOL_ID = "us-east-1:00000000-0000-4000-8000-000000000029";
  const LOGIN_KEY = `cognito-idp.us-east-1.amazonaws.com/${MOCK_COGNITO_CONFIG.userPoolId}`;

  interface IdentityCall {
    operation: string;
    body: { IdentityPoolId?: string; Logins?: Record<string, string> };
  }

  /** Cognito Identity: working (synthetic credentials) or failing with a 500; records each call. */
  function identityPool(mode: "ok" | "fail"): IdentityCall[] {
    const calls: IdentityCall[] = [];
    server.use(
      http.post(IDENTITY_ENDPOINT, async ({ request }) => {
        const operation =
          request.headers.get("x-amz-target")?.replace("AWSCognitoIdentityService.", "") ?? "";
        calls.push({ operation, body: (await request.json()) as IdentityCall["body"] });
        if (mode === "fail") {
          return HttpResponse.json(
            { __type: "InternalErrorException", message: "Identity is unavailable." },
            { status: 500, headers: { "x-amzn-errortype": "InternalErrorException:" } },
          );
        }
        const IdentityId = "us-east-1:11111111-1111-4111-8111-111111111111";
        if (operation === "GetId") return HttpResponse.json({ IdentityId });
        return HttpResponse.json({
          IdentityId,
          Credentials: {
            AccessKeyId: "ASIAMOCKMOCKMOCKMOCK",
            SecretKey: "mock-secret",
            SessionToken: "mock-session-token",
            Expiration: Math.floor(Date.now() / 1000) + 3600,
          },
        });
      }),
    );
    return calls;
  }

  const withIdentityPool = () =>
    createAmplifyAuthService(() => ({ ...MOCK_COGNITO_CONFIG, identityPoolId: IDENTITY_POOL_ID }));

  afterEach(async () => {
    // Amplify keeps the credentials it fetched in memory, across services; sign out to drop them.
    await withIdentityPool().signOut();
  });

  it("exchanges the signed-in patient's ID token, under the user pool's login key", async () => {
    const calls = identityPool("ok");
    const service = withIdentityPool();
    await service.signIn("maria.santos", MOCK_PASSWORD);
    await expect(service.getAwsCredentials()).resolves.toMatchObject({
      accessKeyId: "ASIAMOCKMOCKMOCKMOCK",
      secretAccessKey: "mock-secret",
      sessionToken: "mock-session-token",
    });
    const getId = calls.find((call) => call.operation === "GetId");
    expect(getId?.body.IdentityPoolId).toBe(IDENTITY_POOL_ID);
    expect(Object.keys(getId?.body.Logins ?? {})).toEqual([LOGIN_KEY]);
    expect(claims(getId?.body.Logins?.[LOGIN_KEY])).toMatchObject({ token_use: "id" });
  });

  it("keeps getIdToken working when Cognito Identity fails; only the credentials reject", async () => {
    const calls = identityPool("fail");
    const service = withIdentityPool();
    await service.signIn("maria.santos", MOCK_PASSWORD);
    expect(claims(await service.getIdToken())).toMatchObject({ token_use: "id" });
    await expect(service.getAwsCredentials()).rejects.toThrow();
    expect(calls.length).toBeGreaterThan(0);
    expect(claims(await service.getIdToken())).toMatchObject({ token_use: "id" });
  });

  it("is undefined, with no call to Cognito Identity, when the build has no Identity Pool", async () => {
    const calls = identityPool("ok");
    await auth.signIn("maria.santos", MOCK_PASSWORD);
    await expect(auth.getAwsCredentials()).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("is undefined when signed out (no guest access)", async () => {
    const calls = identityPool("ok");
    await expect(withIdentityPool().getAwsCredentials()).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("is undefined when sign-in isn't configured", async () => {
    const unconfigured = createAmplifyAuthService(() => {
      throw new Error("Sign-in is not configured");
    });
    await expect(unconfigured.getAwsCredentials()).resolves.toBeUndefined();
  });
});
