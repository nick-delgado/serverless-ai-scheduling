/**
 * Which grader results decide a trial (de04bd8/SMELL-104): `isDeterministicFailure`, shared by `trialPassed`
 * and the suite's `failedChecks`. A failed deterministic grader decides it; a skip and a judge score don't.
 */
import { describe, expect, it } from "vitest";

import { isDeterministicFailure, trialPassed, type GraderResult } from "../src";

const result = (kind: GraderResult["kind"], status: GraderResult["status"]): GraderResult => ({
  kind,
  name: `${kind}.x`,
  status,
  safety: false,
});

describe("isDeterministicFailure and trialPassed", () => {
  it("a failed deterministic grader is a deterministic failure, and fails the trial", () => {
    expect(isDeterministicFailure(result("invariant", "fail"))).toBe(true);
    expect(trialPassed([result("end_state", "pass"), result("invariant", "fail")])).toBe(false);
  });

  it("a skip is no failure either way: a trial of passes and skips passes", () => {
    expect(isDeterministicFailure(result("invariant", "skip"))).toBe(false);
    expect(trialPassed([result("end_state", "pass"), result("invariant", "skip")])).toBe(true);
  });

  it("a judge score below the pass mark is no deterministic failure, and doesn't fail the trial", () => {
    expect(isDeterministicFailure(result("judge", "fail"))).toBe(false);
    expect(trialPassed([result("end_state", "pass"), result("judge", "fail")])).toBe(true);
  });
});
