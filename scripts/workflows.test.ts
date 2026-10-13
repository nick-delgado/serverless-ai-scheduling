/**
 * Every GitHub workflow that takes AWS credentials (#157, AC3; #72 P6): each `.github/workflows/*.yml` or `*.yaml` with
 * an `aws-actions/configure-aws-credentials` step, in either step form, is read as text with scripts/test/yaml-text.ts
 * and must have:
 *   - no `pull_request_target` trigger, in any `on:` form (no non-comment line names it);
 *   - `id-token: write` only in the job-level `permissions:` of a job with a credentials step, never at workflow level
 *     or in another job;
 *   - one credentials step per job, which masks the account ID and takes `role-to-assume` from `${{ secrets.<NAME> }}`
 *     only (a literal ARN, `vars` or `env` fails);
 *   - after it, in its job, every step carrying its step-level `if:`, or that condition as `always() && <condition>`;
 *     with no `if:` on the credentials step, no later step in its job has one (r1/Q-1 (a)). Steps aren't classified as
 *     calling AWS or not, and a job-level `if:` isn't a step's.
 * `deploy.yml` and `evals.yml` must be among the files checked, so the test fails if either stops being found; a new
 * workflow with a credentials step (#40's `e2e.yml`) is checked without a test edit. The per-workflow tests
 * (scripts/bootstrap-template.test.ts, scripts/eval-gate.test.ts) pin each file's own settings.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  block,
  children,
  credentialsOf,
  CREDENTIALS_USES,
  entries,
  isCredentialsStep,
  items,
} from "./test/yaml-text";

const DIR = join(import.meta.dirname, "..", ".github", "workflows");
const isComment = (line: string): boolean => line.trimStart().startsWith("#");

const workflows = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .map((file) => ({ file, lines: readFileSync(join(DIR, file), "utf8").split("\n") }))
  .filter(({ lines }) => lines.some((l) => CREDENTIALS_USES.test(l)));

/** A workflow's jobs, each as its block. */
function jobsOf(lines: string[]): string[][] {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return children(block(/^jobs:$/, lines)).map((header) => block(new RegExp(`^${escape(header)}$`), lines));
}

/** The `id-token` permission a workflow or a job's `permissions:` grants (`write-all` grants it too). */
function idToken(permissions: string | undefined, lines: () => string[]): string | undefined {
  if (permissions === undefined) return undefined;
  if (permissions !== "") return permissions === "write-all" ? "write" : undefined;
  return entries(lines())["id-token"];
}

/** The `permissions:` line's inline value ("" for a block), or undefined when there is none. */
const permissionsValue = (direct: string[]): string | undefined => {
  const line = direct.find((l) => /^\s*permissions:/.test(l));
  return line === undefined ? undefined : line.replace(/^\s*permissions:\s*/, "").trim();
};

const SECRET = /^\$\{\{ secrets\.[A-Za-z_][A-Za-z0-9_]* \}\}$/;

it("checks deploy.yml and evals.yml, at least", () => {
  expect(workflows.map((w) => w.file)).toEqual(expect.arrayContaining(["deploy.yml", "evals.yml"]));
});

describe.each(workflows)("$file (a workflow with a credentials step)", ({ lines }) => {
  const jobs = jobsOf(lines);
  const credentialJobs = jobs.filter((job) => job.some((l) => CREDENTIALS_USES.test(l)));
  const stepsOf = (job: string[]): string[][] => items(block(/^\s+steps:$/, job));

  it("has no pull_request_target trigger, in any form", () => {
    expect(lines.filter((l) => !isComment(l) && l.includes("pull_request_target"))).toEqual([]);
  });

  it("grants id-token: write only at job level, and only to a job with a credentials step", () => {
    const topLevel = lines.filter((l) => /^\S/.test(l) && !isComment(l));
    expect(idToken(permissionsValue(topLevel), () => block(/^permissions:$/, lines))).toBeUndefined();
    for (const job of jobs) {
      const own = idToken(permissionsValue(children(job)), () => block(/^\s+permissions:$/, job));
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
