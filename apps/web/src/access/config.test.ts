import { describe, expect, it } from "vitest";

import { requestAccessEnabled, turnstileSiteKey, usesMockBotCheck } from "./config";

describe("requestAccessEnabled", () => {
  it("is on only for exactly 'on'", () => {
    expect(requestAccessEnabled({ VITE_REQUEST_ACCESS: "on" })).toBe(true);
    expect(requestAccessEnabled({ VITE_REQUEST_ACCESS: " on " })).toBe(true);
    for (const value of ["off", "", "ON", "true", "1", undefined]) {
      expect(requestAccessEnabled({ VITE_REQUEST_ACCESS: value }), String(value)).toBe(false);
    }
    expect(requestAccessEnabled({})).toBe(false);
  });
});

describe("turnstileSiteKey", () => {
  it("is the trimmed key, or undefined when there is none", () => {
    expect(turnstileSiteKey({ VITE_TURNSTILE_SITE_KEY: " 1x00000000000000000000AA " })).toBe(
      "1x00000000000000000000AA",
    );
    expect(turnstileSiteKey({ VITE_TURNSTILE_SITE_KEY: "  " })).toBeUndefined();
    expect(turnstileSiteKey({})).toBeUndefined();
  });
});

describe("usesMockBotCheck", () => {
  it("is true only on the dev server with no site key", () => {
    expect(usesMockBotCheck({ DEV: true })).toBe(true);
    expect(usesMockBotCheck({ DEV: true, VITE_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" })).toBe(false);
    expect(usesMockBotCheck({ DEV: false })).toBe(false);
    expect(usesMockBotCheck({})).toBe(false);
  });
});
