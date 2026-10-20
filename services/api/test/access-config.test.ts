import { describe, expect, it } from "vitest";

import { requestAccessConfigFromEnv } from "../src/lib/access-config";

const BASE = { TABLE_NAME: "t", USER_POOL_ID: "pool-a", TURNSTILE_SECRET: "secret-value" };

describe("requestAccessConfigFromEnv", () => {
  it("defaults to 10 a day, 5 at once, 24 hours, and no hostname check", () => {
    expect(requestAccessConfigFromEnv(BASE)).toEqual({
      tableName: "t",
      userPoolId: "pool-a",
      turnstileSecret: "secret-value",
      expectedHostname: "",
      caps: { daily: 10, active: 5 },
      expiryHours: 24,
    });
  });

  it("reads the caps, the expiry and the hostname", () => {
    expect(
      requestAccessConfigFromEnv({
        ...BASE,
        ACCESS_DAILY_CAP: "2",
        ACCESS_ACTIVE_CAP: "3",
        ACCESS_EXPIRY_HOURS: "1",
        TURNSTILE_EXPECTED_HOSTNAME: " demo.example ",
      }),
    ).toMatchObject({ caps: { daily: 2, active: 3 }, expiryHours: 1, expectedHostname: "demo.example" });
  });

  it.each(["TABLE_NAME", "USER_POOL_ID", "TURNSTILE_SECRET"])("fails when %s is missing", (name) => {
    expect(() => requestAccessConfigFromEnv({ ...BASE, [name]: undefined })).toThrow(name);
  });

  it("fails on a cap that isn't a positive integer, without printing the secret", () => {
    expect(() => requestAccessConfigFromEnv({ ...BASE, ACCESS_DAILY_CAP: "0" })).toThrow("ACCESS_DAILY_CAP");
    try {
      requestAccessConfigFromEnv({ ...BASE, ACCESS_ACTIVE_CAP: "x" });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});
