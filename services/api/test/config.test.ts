/** Environment parsing for the API Lambdas (`lib/config.ts`). */
import { describe, expect, it } from "vitest";

import { DEFAULT_DAILY_TURN_CAP } from "../src";
import { chatConfigFromEnv, positiveIntEnv, requireEnv } from "../src/lib/config";

describe("requireEnv", () => {
  it("returns the trimmed value", () => {
    expect(requireEnv({ X: "  sched-dev-table \n" }, "X")).toBe("sched-dev-table");
  });

  it.each([
    ["missing", {}],
    ["empty", { X: "" }],
    ["only whitespace", { X: "   " }],
  ])("throws when the value is %s", (_name, env) => {
    expect(() => requireEnv(env, "X")).toThrow("Missing required environment variable X");
  });
});

describe("positiveIntEnv", () => {
  it.each([
    ["missing", {}, 7],
    ["empty", { N: "" }, 7],
    ["only whitespace", { N: "  " }, 7],
    ["a positive integer", { N: "12" }, 12],
    ["a padded positive integer", { N: " 3 " }, 3],
    ["one", { N: "1" }, 1],
  ])("reads %s", (_name, env, expected) => {
    expect(positiveIntEnv(env, "N", 7)).toBe(expected);
  });

  it.each([
    ["a fraction", "1.5"],
    ["zero", "0"],
    ["a negative integer", "-2"],
    ["not a number", "fifty"],
  ])("throws on %s", (_name, raw) => {
    expect(() => positiveIntEnv({ N: raw }, "N", 7)).toThrow(`N must be a positive integer, got "${raw}"`);
  });
});

describe("chatConfigFromEnv", () => {
  it("reads the table, the model profile and the cap, with their defaults", () => {
    const config = chatConfigFromEnv({ TABLE_NAME: "sched-dev-table" });
    expect(config.tableName).toBe("sched-dev-table");
    expect(config.profile.name).toBe("sonnet-4.6");
    expect(config.dailyTurnCap).toBe(DEFAULT_DAILY_TURN_CAP);
  });

  it("takes DAILY_TURN_CAP and AGENT_MODEL_PROFILE from the environment", () => {
    const config = chatConfigFromEnv({
      TABLE_NAME: "sched-dev-table",
      DAILY_TURN_CAP: "5",
      AGENT_MODEL_PROFILE: "haiku-4.5",
    });
    expect(config.dailyTurnCap).toBe(5);
    expect(config.profile.name).toBe("haiku-4.5");
  });

  it("fails without TABLE_NAME", () => {
    expect(() => chatConfigFromEnv({})).toThrow("TABLE_NAME");
  });
});
