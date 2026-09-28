import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "./index";

describe("@sched/web", () => {
  it("is wired into the workspace", () => {
    expect(PACKAGE_NAME).toBe("@sched/web");
  });
});
