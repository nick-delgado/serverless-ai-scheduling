/**
 * Every GitHub workflow that takes AWS credentials (#157, AC3; #72 P6): each `.github/workflows/*.yml` or `*.yaml` with
 * an `aws-actions/configure-aws-credentials` step, in either step form and quoted or not, is read as text with
 * scripts/test/yaml-text.ts and must have:
 *   - no `pull_request_target` trigger, in any `on:` form (no structural line names it);
 *   - `id-token: write` only in the job-level `permissions:` of a job with a credentials step, never at workflow level
 *     or in another job, whether `permissions:` is a block, a one-line flow map or `write-all`; any other one-line
 *     value (`read-all` aside), such as an anchor, an alias or a flow map over several lines, fails as unreadable;
 *   - one credentials step per job, which masks the account ID and takes `role-to-assume` from `${{ secrets.<NAME> }}`
 *     only (a literal ARN, `vars` or `env` fails);
 *   - after it, in its job, every step carrying its step-level `if:`, or that condition as `always() && <condition>`;
 *     with no `if:` on the credentials step, no later step in its job has one (r1/Q-1 (a)). Steps aren't classified as
 *     calling AWS or not, and a job-level `if:` isn't a step's.
 * `deploy.yml` and `evals.yml` must be among the files checked, so the test fails if either stops being found; a new
 * workflow with a credentials step is found here without a test edit. Each credentials workflow also gets a test of
 * its own settings, in its per-workflow test file (decision 607c339/TEST-201 (a) on PR #262): `deploy.yml`'s and
 * `e2e.yml`'s in scripts/bootstrap-template.test.ts, `evals.yml`'s in scripts/eval-gate.test.ts.
 *
 * It also pins `pr-evidence.yml` (#265), which takes no credentials: its runs queue rather than cancel the running
 * one (`cancel-in-progress: false`, B10-2), a newer run waits behind earlier pending ones rather than replacing them
 * (`queue: max`, #267, B10-2a), and its `PR body` job passes the title and body to scripts/pr-body.ts
 * through `env:`, never in the `run:` line (r1/A-10).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  block,
  childBlocks,
  credentialsLines,
  credentialsOf,
  entries,
  isCredentialsStep,
  member,
  root,
  stepsOf,
  structuralLines,
} from "./test/yaml-text";

const DIR = join(import.meta.dirname, "..", ".github", "workflows");

const workflows = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .map((file) => ({ file, lines: readFileSync(join(DIR, file), "utf8").split("\n") }))
  .filter(({ lines }) => credentialsLines(lines).length > 0);

/** The one-line `permissions:` strings GitHub defines; any other string is a form this test can't read. */
const PERMISSION_STRINGS = ["read-all", "write-all"];

/**
 * The `id-token` permission a `permissions:` value grants, as `member` reads it: a block, a one-line flow map, or one
 * of `PERMISSION_STRINGS` (`write-all` grants it, as GitHub reads it). Any other string fails the calling test: an
 * anchor (`&base`), an alias (`*base`) or a flow map spread over several lines reads as a string, and could hide a grant.
 */
function idToken(permissions: ReturnType<typeof member>, where: string): string | undefined {
  if (typeof permissions !== "string") return permissions?.["id-token"];
  expect(PERMISSION_STRINGS, `${where}: permissions: ${permissions} is not a form this test reads`).toContain(
    permissions,
  );
  return permissions === "write-all" ? "write" : undefined;
}

const SECRET = /^\$\{\{ secrets\.[A-Za-z_][A-Za-z0-9_]* \}\}$/;

it("checks deploy.yml and evals.yml, at least", () => {
  expect(workflows.map((w) => w.file)).toEqual(expect.arrayContaining(["deploy.yml", "evals.yml"]));
});

describe.each(workflows)("$file (a workflow with a credentials step)", ({ lines }) => {
  const jobs = childBlocks(block(/^jobs:$/, lines));
  const credentialJobs = jobs.filter((job) => credentialsLines(job).length > 0);

  it("has no pull_request_target trigger, in any form", () => {
    expect(structuralLines(lines).filter((l) => l.includes("pull_request_target"))).toEqual([]);
  });

  it("grants id-token: write only at job level, and only to a job with a credentials step", () => {
    expect(idToken(member(root(lines), "permissions"), "workflow level")).toBeUndefined();
    for (const job of jobs) {
      const own = idToken(member(job, "permissions"), job[0] ?? "a job");
      expect(own, job[0]).toBe(credentialJobs.includes(job) ? "write" : undefined);
    }
  });

  it("has one credentials step per job, which masks the account ID and takes the role from a secret", () => {
    expect(credentialJobs.length).toBeGreaterThan(0);
    for (const job of credentialJobs) {
      const { lines: named, steps, settings } = credentialsOf(job);
      expect([named, steps.length], job[0]).toEqual([1, 1]);
      expect(settings["mask-aws-account-id"], job[0]).toBe("true");
      expect(settings["role-to-assume"], job[0]).toMatch(SECRET);
    }
  });

  it("gives every step after the credentials step, in its job, the credentials step's if:", () => {
    for (const job of credentialJobs) {
      const steps = stepsOf(job);
      const at = steps.findIndex(isCredentialsStep);
      const condition = entries(steps[at] ?? []).if;
      const allowed = condition === undefined ? [undefined] : [condition, `always() && ${condition}`];
      for (const step of steps.slice(at + 1)) expect(allowed, step[0]).toContain(entries(step).if);
    }
  });
});

describe("pr-evidence.yml (#265)", () => {
  const lines = readFileSync(join(DIR, "pr-evidence.yml"), "utf8").split("\n");

  it("lets a body edit's run wait for the running one instead of cancelling it (B10-2)", () => {
    expect(entries(block(/^concurrency:$/, lines))["cancel-in-progress"]).toBe("false");
  });

  it("keeps every pending run in the queue instead of only the newest (B10-2a, #267)", () => {
    expect(entries(block(/^concurrency:$/, lines)).queue).toBe("max");
  });

  it("runs pr-body.ts as the PR body job, with the title and body only in env: (r1/A-10)", () => {
    const job = block(/^ {2}pr-body:$/, block(/^jobs:$/, lines));
    expect(entries(job).name).toBe("PR body");
    const step = stepsOf(job).find((s) => entries(s).run?.includes("scripts/pr-body.ts"));
    expect(entries(step ?? []).run).toBe("npx tsx scripts/pr-body.ts");
    expect(member(step ?? [], "env")).toEqual({
      PR_TITLE: "${{ github.event.pull_request.title }}",
      PR_BODY: "${{ github.event.pull_request.body }}",
    });
    expect(job.filter((line) => /^\s+-? ?run:/.test(line) && line.includes("${{"))).toEqual([]);
  });
});
