import { ToolError } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { toolFail, toolOk } from "../src/handler";

describe("handler result helpers", () => {
  it("toolOk wraps the output", () => {
    expect(toolOk({ providers: [] })).toStrictEqual({ ok: true, output: { providers: [] } });
  });

  it("toolFail without a hint leaves the hint key out, so the ToolError has no `hint: undefined`", () => {
    const result = toolFail("NOT_FOUND", "No profile on file.");
    expect(result).toStrictEqual({
      ok: false,
      error: { error: { code: "NOT_FOUND", message: "No profile on file." } },
    });
    expect(ToolError.parse(result.error)).toStrictEqual(result.error);
  });

  it("toolFail with a hint carries it", () => {
    expect(toolFail("INTERNAL", "Failed.", "Try once more.")).toStrictEqual({
      ok: false,
      error: { error: { code: "INTERNAL", message: "Failed.", hint: "Try once more." } },
    });
  });
});
