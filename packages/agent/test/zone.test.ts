import { describe, expect, it } from "vitest";

// Guard for #210: this package's vitest.config.ts runs its tests in America/Los_Angeles, so they can catch date
// code that reads the machine's zone where Los Angeles and the right zone disagree. Dropping that setting fails
// this test.
describe("test time zone (#210)", () => {
  it("runs the tests of @sched/agent in America/Los_Angeles", () => {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/Los_Angeles");
  });
});
