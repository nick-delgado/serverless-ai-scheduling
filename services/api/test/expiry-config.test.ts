import { describe, expect, it } from "vitest";

import { expiryConfigFromEnv } from "../src/lib/expiry-config";

describe("expiryConfigFromEnv", () => {
  it("reads the table and the pool", () => {
    expect(expiryConfigFromEnv({ TABLE_NAME: "t", USER_POOL_ID: "pool-a" })).toEqual({
      tableName: "t",
      userPoolId: "pool-a",
    });
  });

  it.each(["TABLE_NAME", "USER_POOL_ID"])("fails the cold start when %s is missing", (name) => {
    expect(() => expiryConfigFromEnv({ TABLE_NAME: "t", USER_POOL_ID: "p", [name]: undefined })).toThrow(
      name,
    );
  });
});
