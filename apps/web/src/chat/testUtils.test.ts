/**
 * When `until` gives up (#134): only after both its hop floor and its real-time floor. The clock is
 * `performance.now()`, stubbed here so each condition check moves it a known step.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { UNTIL_MIN_HOPS, UNTIL_MIN_MS, until, untilFound } from "./testUtils";

// Each test runs hundreds of real hops, which a loaded runner can stretch past the 5 s default.
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.restoreAllMocks();
});

/** A condition that never holds and moves the stubbed clock `stepMs` per check; counts the checks. */
function neverWithClock(stepMs: number) {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const checks = { count: 0 };
  const condition = () => {
    checks.count += 1;
    now += stepMs;
    return false;
  };
  return { checks, condition };
}

describe("until", () => {
  it("keeps running hops past its hop floor until its time floor has passed", async () => {
    // 5 ms per check: past the hop floor at 2.5 s, so only the time floor keeps it going to 600 checks.
    const { checks, condition } = neverWithClock(5);
    await expect(until(condition)).rejects.toThrow("until: the condition never held");
    expect(checks.count).toBe(UNTIL_MIN_MS / 5);
  });

  it("runs its hop floor even when the time floor has long passed", async () => {
    const { checks, condition } = neverWithClock(10 * UNTIL_MIN_MS);
    await expect(until(condition)).rejects.toThrow("until: the condition never held");
    expect(checks.count).toBe(UNTIL_MIN_HOPS);
  });

  it("returns as soon as the condition holds", async () => {
    let checks = 0;
    await until(() => (checks += 1) === 3);
    expect(checks).toBe(3);
  });
});

describe("untilFound", () => {
  it("returns what the query finds, once it finds something", async () => {
    const found = { name: "the element" };
    let queries = 0;
    await expect(untilFound(() => ((queries += 1) < 3 ? null : found))).resolves.toBe(found);
    expect(queries).toBe(3);
  });
});
