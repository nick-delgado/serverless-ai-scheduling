/**
 * scripts/eval-gate.ts (#34, FR-041), with no Bedrock calls: the path classifier (r1/Q-3 (b)), the plan with and
 * without credentials (r1/Q-2 (a)), the re-run merge (r1/A-4), each fail rule of the verdict, exactly the allowed
 * regressions, and `main` against a throwaway git repository and in-memory results files.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { baselineFromReports, type Baseline, type RunReport } from "@sched/evals";

import { fakeReport, passing, type FakeCase } from "../packages/evals/test/report-helpers";
import {
  collapsed,
  erroredIds,
  gateVerdict,
  isGatedPath,
  main,
  mergeRerun,
  planGate,
  verdictMarkdown,
} from "./eval-gate";
import { gitRepo, logsTo, type TestRepo } from "./test/git-repo";

describe("isGatedPath (r1/Q-3 (b))", () => {
  it.each([
    ["packages/agent/src/loop.ts", true],
    ["packages/agent/src/prompts/system.ts", true],
    ["packages/agent/src/profiles.ts", true],
    ["packages/agent/test/loop.test.ts", true], // globs match as written: tests under agent/** count
    ["packages/agent/package.json", true],
    ["packages/tools/src/tools/book.ts", true],
    ["packages/tools/test/book.test.ts", true],
    ["packages/contracts/src/tools.ts", true],
    ["packages/contracts/src/dates.ts", true],
    ["packages/contracts/src/api.ts", true],
    ["packages/contracts/src/api.test.ts", false],
    ["packages/contracts/test/tools.test.ts", false],
    ["packages/contracts/package.json", false],
    ["packages/evals/src/graders/text.ts", true],
    ["packages/evals/scenarios/book/book-a.yaml", true],
    ["packages/evals/baselines/sonnet-4.6.json", true],
    ["packages/evals/test/graders.test.ts", false],
    [".github/workflows/evals.yml", true],
    [".github/workflows/ci.yml", false],
    ["package.json", false],
    ["package-lock.json", false],
    ["services/api/src/chat.ts", false],
    ["docs/adr/0008-evaluation-strategy.md", false],
    ["apps/web/src/App.tsx", false],
  ])("%s → %s", (path, gated) => {
    expect(isGatedPath(path)).toBe(gated);
  });
});

describe("planGate (r1/Q-2 (a))", () => {
  const base = { hasCredentials: true, fork: false, dependabot: false };

  it("no gated path: passes without running, whoever opened the PR and with or without credentials", () => {
    for (const p of [
      base,
      { ...base, hasCredentials: false, fork: true },
      { ...base, hasCredentials: false, dependabot: true },
    ])
      expect(planGate({ ...p, changed: ["docs/a.md", "package-lock.json"] })).toMatchObject({
        run: false,
        gated: [],
      });
  });

  it("a gated path with credentials: runs", () => {
    expect(planGate({ ...base, changed: ["docs/a.md", "packages/tools/src/x.ts"] })).toMatchObject({
      run: true,
      gated: ["packages/tools/src/x.ts"],
    });
  });

  it("a gated path without credentials: fails closed, naming a fork, Dependabot, or a missing secret", () => {
    const changed = ["packages/agent/src/x.ts"];
    const fork = planGate({ ...base, changed, hasCredentials: false, fork: true });
    expect(fork.run).toBe(false);
    expect(fork.failure).toContain("this is a pull request from a fork, so the run has no AWS credentials");
    expect(fork.failure).toContain("Nick pushes the branch to this repository");
    const many = planGate({
      ...base,
      changed: Array.from({ length: 12 }, (_, i) => `packages/tools/src/f${i}.ts`),
    });
    expect(many.summary).toContain("`packages/tools/src/f9.ts` and 2 more.");
    const bot = planGate({ ...base, changed, hasCredentials: false, dependabot: true }).failure;
    expect(bot).toContain("this is a Dependabot pull request");
    expect(bot).toContain("Nick gives the run credentials (a push of his own to the branch");
    expect(planGate({ ...base, changed, hasCredentials: false }).failure).toContain(
      "this is a run without the AWS_EVAL_ROLE_ARN secret",
    );
  });
});

const l1Base = fakeReport("l1", passing("l1", 4));
const scBase = fakeReport("scenario", passing("sc", 4));
const baseline: Baseline = baselineFromReports([l1Base, scBase]);

/** A run of `mode` where the given cases have these trials, the rest pass. */
const run = (
  mode: "l1" | "scenario",
  prefix: string,
  changes: Record<string, FakeCase["trials"]> = {},
  extra: Partial<FakeCase> = {},
) =>
  fakeReport(
    mode,
    passing(prefix, 4).map((c) => ({
      ...c,
      ...(changes[c.id] === undefined ? {} : { trials: changes[c.id] }),
      ...(c.id === `${prefix}-4` ? extra : {}),
    })),
  );
const clean = () => ({ l1: { first: run("l1", "l1") }, scenario: { first: run("scenario", "sc") } });

describe("gateVerdict (FR-041)", () => {
  it("passes a run that matches the baseline", () => {
    expect(gateVerdict(baseline, clean())).toMatchObject({ passed: true, failures: [] });
  });

  it("fails on any safety violation, even in a passing case", () => {
    const v = gateVerdict(baseline, {
      ...clean(),
      l1: { first: run("l1", "l1", { "l1-1": [{ status: "pass", safetyViolations: 1 }] }) },
    });
    expect(v.failures).toEqual(["l1: 1 safety violation(s)"]);
  });

  it("exactly one regression in each mode passes; two in one mode fail", () => {
    const one = gateVerdict(baseline, {
      l1: { first: run("l1", "l1", { "l1-1": [{ status: "fail" }] }) },
      scenario: { first: run("scenario", "sc", { "sc-2": [{ status: "fail" }] }) },
    });
    expect(one.passed).toBe(true);
    const two = gateVerdict(baseline, {
      ...clean(),
      scenario: {
        first: run("scenario", "sc", { "sc-1": [{ status: "fail" }], "sc-2": [{ status: "fail" }] }),
      },
    });
    expect(two.failures).toEqual(["scenario: 2 case(s) below the baseline (at most 1): sc-1, sc-2"]);
  });

  it("fails on a budget-stopped case", () => {
    const v = gateVerdict(baseline, {
      ...clean(),
      l1: { first: run("l1", "l1", {}, { budgetStopped: true }) },
    });
    expect(v.failures).toEqual(["l1: budget-stopped case(s): l1-4"]);
  });

  it("a re-run that passes replaces the errored status; its safety violations still count", () => {
    const first = run("scenario", "sc", { "sc-3": [{ status: "error" }] });
    const rerun = fakeReport("scenario", [{ id: "sc-3", trials: [{ status: "pass" }] }]);
    expect(erroredIds(first)).toEqual(["sc-3"]);
    const v = gateVerdict(baseline, { ...clean(), scenario: { first, rerun } });
    expect(v.passed).toBe(true);
    expect(v.merged[1]).toMatchObject({ rerunIds: ["sc-3"], stillErrored: [] });
    const unsafe = fakeReport("scenario", [
      { id: "sc-3", trials: [{ status: "pass", safetyViolations: 2 }] },
    ]);
    expect(gateVerdict(baseline, { ...clean(), scenario: { first, rerun: unsafe } }).failures).toEqual([
      "scenario: 2 safety violation(s)",
    ]);
  });

  it("fails on a case still error after the re-run, even within the regression allowance", () => {
    const first = run("l1", "l1", { "l1-2": [{ status: "error" }] });
    const rerun = fakeReport("l1", [{ id: "l1-2", trials: [{ status: "error" }] }]);
    const v = gateVerdict(baseline, { ...clean(), l1: { first, rerun } });
    expect(v.failures).toEqual(["l1: still `error` after the re-run: l1-2"]);
    // Without a re-run, the errored case is still `error`.
    expect(gateVerdict(baseline, { ...clean(), l1: { first } }).failures).toEqual([
      "l1: still `error` after the re-run: l1-2",
    ]);
  });

  it("counts a budget stop in the re-run too", () => {
    const first = run("l1", "l1", { "l1-2": [{ status: "error" }] });
    const rerun = fakeReport("l1", [{ id: "l1-2", trials: [], budgetStopped: true }]);
    expect(mergeRerun("l1", { first, rerun }).budgetStopped).toEqual(["l1-2"]);
  });

  it("the summary names the result, the failures, each mode's table and its re-run", () => {
    const first = run("scenario", "sc", { "sc-1": [{ status: "fail" }], "sc-2": [{ status: "error" }] });
    const rerun = fakeReport("scenario", [{ id: "sc-2", trials: [{ status: "fail" }] }]);
    const md = verdictMarkdown(gateVerdict(baseline, { ...clean(), scenario: { first, rerun } }), "b.json");
    expect(md).toContain(
      "## Eval gate: failed\n\n- scenario: 2 case(s) below the baseline (at most 1): sc-1, sc-2",
    );
    expect(md).toContain(
      "### scenario: 2 regression(s) against `b.json`\n- Re-ran the errored case(s) once: sc-2",
    );
    expect(md).toContain("| sc-1 | pass | fail | **regression** |");
    expect(md).toContain("| l1-1 | pass | pass |  |");
    // A case new since the baseline shows – for its baseline status; another model is a warning.
    const fresh = fakeReport("l1", [...passing("l1", 4), { id: "l1-new", trials: [{ status: "pass" }] }], {
      modelId: "other-model",
    });
    const md2 = verdictMarkdown(gateVerdict(baseline, { ...clean(), l1: { first: fresh } }), "b.json");
    expect(md2).toContain("| l1-new | – | pass | new since the baseline; not counted |");
    expect(md2).toContain("- Warning: model ID other-model, baseline us.anthropic.claude-sonnet-4-6");
    expect(verdictMarkdown(gateVerdict(baseline, clean()), "b.json")).toContain(
      "## Eval gate: passed\n\nNo safety violation",
    );
  });

  it("collapses a run's markdown under its title", () => {
    expect(collapsed("# Eval run: l1\n\n- line")).toBe(
      "<details><summary>Eval run: l1</summary>\n\n- line\n\n</details>\n",
    );
  });
});

describe("main", () => {
  let out: string[];
  let errors: string[];
  let appended: Map<string, string>;
  const envFiles = { GITHUB_OUTPUT: "/gh/output", GITHUB_STEP_SUMMARY: "/gh/summary" };
  const append = (p: string, t: string) => appended.set(p, (appended.get(p) ?? "") + t);

  beforeEach(() => {
    out = [];
    errors = [];
    appended = new Map();
  });

  describe("plan", () => {
    let repo: TestRepo;
    beforeEach(() => {
      repo = gitRepo("eval-gate-");
      repo.write("docs/a.md", "a\n");
      repo.write(
        "packages/tools/src/old.ts",
        "export const old = 1;\n// a body long enough to pair as a rename\n",
      );
      repo.commit("base");
      repo.git("checkout", "-q", "-b", "feature");
    });
    afterEach(() => repo.remove());
    const deps = () => ({ cwd: repo.dir, ...logsTo(out, errors), append });

    it("no gated path changed: run=false, exit 0", () => {
      repo.write("docs/a.md", "b\n");
      repo.commit("docs");
      expect(main(["plan", "--base", "main"], { ...envFiles, AWS_EVAL_ROLE_ARN: "" }, deps())).toBe(0);
      expect(appended.get("/gh/output")).toBe("run=false\n");
      expect(appended.get("/gh/summary")).toContain("passes without calling Bedrock");
    });

    it("a file renamed out of a gated path counts under its old name", () => {
      repo.git("mv", "packages/tools/src/old.ts", "docs/old.ts");
      repo.commit("move");
      expect(main(["plan"], { ...envFiles, PR_BASE: "main", AWS_EVAL_ROLE_ARN: "set" }, deps())).toBe(0);
      expect(appended.get("/gh/output")).toBe("run=true\n");
      expect(out[0]).toContain("`packages/tools/src/old.ts`");
    });

    it("a gated path on a fork's PR: fails closed, exit 1", () => {
      repo.write("packages/agent/src/x.ts", "export {};\n");
      repo.commit("agent");
      const vars = {
        ...envFiles,
        PR_BASE: "main",
        PR_HEAD_REPO: "someone/fork",
        GITHUB_REPOSITORY: "owner/repo",
      };
      expect(main(["plan"], vars, deps())).toBe(1);
      expect(appended.get("/gh/output")).toBe("run=false\n");
      expect(errors[0]).toMatch(/^::error::Gated paths changed .*a pull request from a fork/);
    });

    it("a base with no merge base: exit 2", () => {
      expect(main(["plan", "--base", "nope"], {}, deps())).toBe(2);
    });
  });

  describe("errored and verdict", () => {
    const dir = "/r";
    const store = new Map<string, string>();
    const put = (sub: string, report: RunReport) => {
      store.set(join(dir, sub, "run.json"), JSON.stringify(report));
      store.set(join(dir, sub, "run.md"), `# Eval run: ${sub}\n\nsummary of ${sub}`);
    };
    const deps = () => ({
      ...logsTo(out, errors),
      append,
      listJson: (d: string) => {
        const names = [...store.keys()]
          .filter((k) => k.startsWith(`${d}/`) && k.endsWith(".json"))
          .map((k) => k.slice(d.length + 1));
        return names.length === 0 ? undefined : names;
      },
      readText: (p: string) => {
        const t = store.get(p);
        if (t === undefined) throw new Error(`ENOENT ${p}`);
        return t;
      },
    });
    beforeEach(() => {
      store.clear();
      store.set("/b.json", JSON.stringify(baseline));
      put("l1", run("l1", "l1", { "l1-2": [{ status: "error" }] }));
      put(
        "l1-two",
        run("l1", "l1", {
          "l1-1": [{ status: "error" }],
          "l1-3": [{ status: "fail" }],
          "l1-4": [{ status: "error" }],
        }),
      );
      put("scenario", run("scenario", "sc"));
    });

    it("errored prints the errored IDs comma-separated, and an empty line when none", () => {
      expect(main(["errored", "/r/l1"], {}, deps())).toBe(0);
      expect(main(["errored", "/r/scenario"], {}, deps())).toBe(0);
      expect(main(["errored", "/r/l1-two"], {}, deps())).toBe(0);
      // Only errored cases, not failed ones, comma-separated for `--ids`.
      expect(out).toEqual(["l1-2", "", "l1-1,l1-4"]);
      expect(main(["errored", "/r/none"], {}, deps())).toBe(2);
      expect(main(["errored"], {}, deps())).toBe(2);
    });

    it("verdict fails on a case still errored, and writes the comparison and both runs to the job summary", () => {
      expect(main(["verdict", "--results", dir, "--baseline", "/b.json"], envFiles, deps())).toBe(1);
      expect(errors).toEqual(["::error::Eval gate failed: l1: still `error` after the re-run: l1-2"]);
      const summary = appended.get("/gh/summary") ?? "";
      expect(summary).toContain("## Eval gate: failed");
      expect(summary).toContain("<details><summary>Eval run: l1</summary>\n\nsummary of l1");
      expect(summary).toContain("<summary>Eval run: scenario</summary>");
    });

    it("verdict passes once the re-run passes, and leaves out a run with no markdown", () => {
      put("l1-rerun", fakeReport("l1", [{ id: "l1-2", trials: [{ status: "pass" }] }]));
      store.delete("/r/scenario/run.md");
      expect(main(["verdict", "--results", dir, "--baseline", "/b.json"], envFiles, deps())).toBe(0);
      expect(out[0]).toContain("## Eval gate: passed");
      expect(appended.get("/gh/summary")).toContain("<summary>Eval run: l1-rerun</summary>");
      expect(appended.get("/gh/summary")).not.toContain("<summary>Eval run: scenario</summary>");
    });

    it("verdict can't decide without a mode's results, or with a bad baseline: exit 2", () => {
      store.delete("/r/scenario/run.json");
      expect(main(["verdict", "--results", dir, "--baseline", "/b.json"], {}, deps())).toBe(2);
      expect(errors[0]).toContain("no scenario results in /r/scenario (did the run crash?)");
      put("scenario", run("scenario", "sc"));
      store.set("/bad.json", "{}");
      expect(main(["verdict", "--results", dir, "--baseline", "/bad.json"], {}, deps())).toBe(2);
      expect(errors[1]).toMatch(/^eval-gate: \/bad\.json isn't a baseline/);
      store.set(join(dir, "scenario", "two.json"), "{}");
      expect(main(["verdict", "--results", dir, "--baseline", "/b.json"], {}, deps())).toBe(2);
      expect(errors[2]).toBe("eval-gate: /r/scenario holds 2 results files, not one");
    });

    it("usage errors: exit 2", () => {
      expect(main(["verdict", "--results", dir], {}, deps())).toBe(2);
      expect(main(["nonsense"], {}, deps())).toBe(2);
      expect(main(["plan", "--bogus"], {}, deps())).toBe(2);
    });
  });

  describe("on real files (the default readers and writers)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "eval-gate-files-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("errored reads the directory and file; plan appends to the GITHUB_OUTPUT file", () => {
      mkdirSync(join(dir, "l1"));
      writeFileSync(
        join(dir, "l1", "run.json"),
        JSON.stringify(run("l1", "l1", { "l1-3": [{ status: "error" }] })),
      );
      expect(main(["errored", join(dir, "l1")], {}, logsTo(out, errors))).toBe(0);
      expect(out).toEqual(["l1-3"]);
      expect(main(["errored", join(dir, "none")], {}, logsTo(out, errors))).toBe(2);

      const repo = gitRepo("eval-gate-plan-");
      try {
        repo.write("docs/a.md", "a\n");
        repo.commit("base");
        const output = join(dir, "output");
        expect(
          main(
            ["plan", "--base", "HEAD"],
            { GITHUB_OUTPUT: output },
            { cwd: repo.dir, ...logsTo(out, errors) },
          ),
        ).toBe(0);
        expect(readFileSync(output, "utf8")).toBe("run=false\n");
      } finally {
        repo.remove();
      }
    });
  });
});
