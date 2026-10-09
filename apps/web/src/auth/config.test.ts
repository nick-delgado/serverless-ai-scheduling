import { describe, expect, it } from "vitest";

import { resolveCognitoConfig, resolveIdentityPoolId } from "./config";

const MOCK = { userPoolId: "us-east-1_Mock", userPoolClientId: "mockclient" };

describe("resolveCognitoConfig", () => {
  it("uses both IDs from the build environment, trimmed, over the fallback", () => {
    expect(
      resolveCognitoConfig({ VITE_USER_POOL_ID: " us-east-1_Pool ", VITE_SPA_CLIENT_ID: "client\n" }, MOCK),
    ).toEqual({ userPoolId: "us-east-1_Pool", userPoolClientId: "client" });
  });

  it("falls back (to the mock, in development) when neither is set", () => {
    expect(resolveCognitoConfig({}, MOCK)).toBe(MOCK);
    expect(resolveCognitoConfig({ VITE_USER_POOL_ID: " ", VITE_SPA_CLIENT_ID: "" }, MOCK)).toBe(MOCK);
  });

  it.each([[{ VITE_USER_POOL_ID: "us-east-1_Pool" }], [{ VITE_SPA_CLIENT_ID: "client" }]])(
    "refuses half a configuration, even with a fallback: %o",
    (env) => {
      expect(() => resolveCognitoConfig(env, MOCK)).toThrow(/VITE_USER_POOL_ID and VITE_SPA_CLIENT_ID/);
    },
  );

  it("refuses to run unconfigured without a fallback (production builds)", () => {
    expect(() => resolveCognitoConfig({})).toThrow(/not configured/);
  });
});

describe("the Identity Pool ID (S6-02, #29)", () => {
  const BUILD = { VITE_USER_POOL_ID: "us-east-1_Pool", VITE_SPA_CLIENT_ID: "client" };

  it("is added, trimmed, when the build sets it beside the pool and client IDs", () => {
    expect(resolveCognitoConfig({ ...BUILD, VITE_IDENTITY_POOL_ID: " us-east-1:abc \n" })).toEqual({
      userPoolId: "us-east-1_Pool",
      userPoolClientId: "client",
      identityPoolId: "us-east-1:abc",
    });
    expect(resolveIdentityPoolId({ ...BUILD, VITE_IDENTITY_POOL_ID: "us-east-1:abc" })).toBe("us-east-1:abc");
  });

  it("is optional: sign-in is configured without it, and voice has none", () => {
    expect(resolveCognitoConfig({ ...BUILD, VITE_IDENTITY_POOL_ID: " " })).toEqual({
      userPoolId: "us-east-1_Pool",
      userPoolClientId: "client",
    });
    expect(resolveIdentityPoolId(BUILD)).toBeUndefined();
  });

  it("is ignored on the mock fallback, whose tokens can't be exchanged", () => {
    expect(resolveCognitoConfig({ VITE_IDENTITY_POOL_ID: "us-east-1:abc" }, MOCK)).toBe(MOCK);
    expect(resolveIdentityPoolId({ VITE_IDENTITY_POOL_ID: "us-east-1:abc" })).toBeUndefined();
  });
});
