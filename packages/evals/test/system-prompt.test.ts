/** The harness's default system prompt: the production one, built from the trial's clock and first name. */
import { describe, expect, it } from "vitest";

import { promptFor } from "../src";

const NOW = new Date("2026-10-05T13:00:00Z"); // Mon Oct 5 2026, 9:00 AM EDT

describe("promptFor default", () => {
  it("without a first name, the production prompt says the name isn't known instead of using a placeholder", () => {
    const system = promptFor(undefined, NOW, undefined);
    expect(system.version).toBe("system.v1");
    expect(system.dynamic).toContain("The patient's first name isn't known.");
    expect(system.dynamic).not.toContain("there");
  });
});
