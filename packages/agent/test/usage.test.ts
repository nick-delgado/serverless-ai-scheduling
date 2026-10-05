import { describe, expect, it } from "vitest";

import { addUsage, zeroUsage } from "../src";

describe("zeroUsage / addUsage (#105)", () => {
  it("starts at zero, in a fresh object each call", () => {
    expect(zeroUsage()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(zeroUsage()).not.toBe(zeroUsage());
  });

  it("adds every field on its own", () => {
    expect(
      addUsage(
        { inputTokens: 1, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 4000 },
        { inputTokens: 5, outputTokens: 60, cacheReadTokens: 700, cacheWriteTokens: 8000 },
      ),
    ).toEqual({ inputTokens: 6, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 12000 });
  });
});
