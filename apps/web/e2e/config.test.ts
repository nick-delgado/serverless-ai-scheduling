// @vitest-environment node
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import config from "../playwright.config";

const dir = import.meta.dirname;
const specs = readdirSync(dir).filter((f) => f.endsWith(".e2e.ts"));

/** The projects that run `file`: each project's `testMatch` against the spec's absolute path. */
function projectsOf(file: string): string[] {
  return (config.projects ?? [])
    .filter((p) => {
      const match = p.testMatch;
      return match instanceof RegExp && match.test(join(dir, file));
    })
    .map((p) => p.name ?? "");
}

describe("the E2E config (r1/Q-1 (a), r1/A-4)", () => {
  it("runs one worker, serially, with no retries", () => {
    expect(config.workers).toBe(1);
    expect(config.fullyParallel).toBe(false);
    expect(config.retries).toBe(0);
  });

  it("runs the projects in order: the three browsers, then Chromium's last journeys", () => {
    expect((config.projects ?? []).map((p) => p.name)).toEqual([
      "chromium",
      "webkit",
      "firefox",
      "chromium-last",
    ]);
  });

  it("runs login and booking on every browser, reschedule and escalation on Chromium last", () => {
    expect(specs.sort()).toEqual([
      "01-login.e2e.ts",
      "02-book.e2e.ts",
      "03-reschedule.e2e.ts",
      "04-escalation.e2e.ts",
    ]);
    expect(Object.fromEntries(specs.map((f) => [f, projectsOf(f)]))).toEqual({
      "01-login.e2e.ts": ["chromium", "webkit", "firefox"],
      "02-book.e2e.ts": ["chromium", "webkit", "firefox"],
      "03-reschedule.e2e.ts": ["chromium-last"],
      "04-escalation.e2e.ts": ["chromium-last"],
    });
  });
});
