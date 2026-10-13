/**
 * scripts/deploy.sh (#137), run for real through the shell harness (scripts/test/shell-harness.ts): each test copies the
 * script and the four infra/stacks templates into a throwaway git repo with one commit, writes that repo's .env (never
 * the developer's), and runs the copy against stand-in `aws` and `sam` that log every call. The main-checkout fallback
 * cases add a `git worktree` of that repo. What's checked is the script's exit code, its output, and the stand-in
 * `sam deploy`'s logged arguments. SAM's own NoEcho masking of the SES values is not something these tests can see.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BAD_ENV_NAMES, GOOD_ENV_NAMES, sandbox, type Sandbox, type ShellRun } from "./test/shell-harness";

const STACKS = ["data", "auth", "api", "web"];

// Synthetic values; none of them exists.
const BOOTSTRAP_SSM = {
  "/sched/bootstrap/cfn-exec-role-arn": "arn:aws:iam::000000000000:role/sched-cfn-exec-test",
  "/sched/bootstrap/artifact-bucket": "sched-test-artifacts",
};
const SENDER = "env-sender@example.com";
const RECIPIENT = "env-staff@example.com";
const SES_ENV = { SES_SENDER: SENDER, SES_STAFF_RECIPIENT: RECIPIENT };
const DOTENV_SENDER = "dotenv-sender@example.com";
const DOTENV_RECIPIENT = "dotenv-staff@example.com";
const DOTENV = `SES_SENDER=${DOTENV_SENDER}\nSES_STAFF_RECIPIENT=${DOTENV_RECIPIENT}\n`;
const MAIN_SENDER = "main-sender@example.com";
const MAIN_RECIPIENT = "main-staff@example.com";
const MAIN_DOTENV = `SES_SENDER=${MAIN_SENDER}\nSES_STAFF_RECIPIENT=${MAIN_RECIPIENT}\n`;
/** Every SES value any test uses, none of which may appear in the script's output. */
const SES_VALUES = [SENDER, RECIPIENT, DOTENV_SENDER, DOTENV_RECIPIENT, MAIN_SENDER, MAIN_RECIPIENT];

let sb: Sandbox;

const run = (args: string[], env: Record<string, string> = {}, root?: string) =>
  sb.run("scripts/deploy.sh", args, { env, root });

const writeEnv = (root: string, text: string) => {
  writeFileSync(join(root, ".env"), text);
};

/** A worktree of the sandbox repo on a new branch, beside the repo inside the test's directory. */
function worktree(): string {
  const path = join(sb.dir, "wt");
  sb.repo.git("worktree", "add", "-q", "-b", "wt", path);
  return path;
}

const deploys = (calls: string[]) => calls.filter((c) => c.startsWith("sam deploy "));
const stackOf = (call: string) => /--stack-name (\S+)/.exec(call)?.[1];
/** The `--parameter-overrides` of each stack's `sam deploy`, by stack name. */
function overrides(calls: string[]): Record<string, string[]> {
  return Object.fromEntries(
    deploys(calls).map((call) => [
      stackOf(call) ?? "",
      (/--parameter-overrides (.*?) --tags /.exec(call)?.[1] ?? "").split(" "),
    ]),
  );
}

/** The run succeeded, and the api stack got exactly these SES values, which the output never shows. */
function expectSes(r: ShellRun, env: string, sender: string, recipient: string): void {
  expect(r.status, r.out).toBe(0);
  const api = overrides(r.calls)[`sched-${env}-api`];
  expect(api).toContain(`SesSender=${sender}`);
  expect(api).toContain(`SesStaffRecipient=${recipient}`);
  expectNotPrinted(r);
}

function expectNotPrinted(r: ShellRun): void {
  for (const value of SES_VALUES) expect(r.out).not.toContain(value);
}

const awsOrSam = (calls: string[]) => calls.filter((c) => c.startsWith("aws ssm") || c.startsWith("sam "));

beforeEach(() => {
  sb = sandbox({
    prefix: "sched-deploy-",
    files: ["scripts/deploy.sh", ...STACKS.map((s) => `infra/stacks/${s}.yaml`)],
    write: { ".gitignore": ".env\n.aws-sam/\n" },
  });
  sb.setSsm(BOOTSTRAP_SSM);
});

afterEach(() => {
  vi.unstubAllEnvs();
  sb.remove();
});

// Each test spawns git and bash several times; on a busy machine that outruns the 5 s default.
describe("deploy.sh", { timeout: 30_000 }, () => {
  describe("the SES values for the api stack", () => {
    it("uses values only in the environment", () => {
      expectSes(run(["api", "pr7"], SES_ENV), "pr7", SENDER, RECIPIENT);
    });

    it("uses values only in .env", () => {
      writeEnv(sb.repo.dir, DOTENV);
      expectSes(run(["api", "pr7"]), "pr7", DOTENV_SENDER, DOTENV_RECIPIENT);
    });

    it("prefers the environment over .env", () => {
      writeEnv(sb.repo.dir, DOTENV);
      expectSes(run(["api", "pr7"], SES_ENV), "pr7", SENDER, RECIPIENT);
    });

    it("falls through to .env when an environment variable is the empty string", () => {
      writeEnv(sb.repo.dir, DOTENV);
      const r = run(["api", "pr7"], { SES_SENDER: "", SES_STAFF_RECIPIENT: RECIPIENT });
      expectSes(r, "pr7", DOTENV_SENDER, RECIPIENT);
    });

    it("deploys the sandbox's own copy: repo_root and the main checkout are inside the test's directory", () => {
      const wt = worktree();
      const r = run(["api", "pr7"], SES_ENV, wt);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`(${wt})`);
      const common = sb.repo.git("-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
      expect(join(common, "..")).toBe(sb.repo.dir);
      expect(sb.repo.dir.startsWith(`${sb.dir}/`)).toBe(true);
    });

    it("falls back to the main checkout's .env from a worktree with none", () => {
      writeEnv(sb.repo.dir, MAIN_DOTENV);
      const wt = worktree();
      expectSes(run(["api", "pr7"], {}, wt), "pr7", MAIN_SENDER, MAIN_RECIPIENT);
    });

    it("falls back to the main checkout's .env for a key the worktree's .env leaves empty", () => {
      writeEnv(sb.repo.dir, MAIN_DOTENV);
      const wt = worktree();
      writeEnv(wt, `SES_SENDER=\nSES_STAFF_RECIPIENT=${DOTENV_RECIPIENT}\n`);
      expectSes(run(["api", "pr7"], {}, wt), "pr7", MAIN_SENDER, DOTENV_RECIPIENT);
    });

    it("prefers the worktree's .env over the main checkout's", () => {
      writeEnv(sb.repo.dir, MAIN_DOTENV);
      const wt = worktree();
      writeEnv(wt, DOTENV);
      expectSes(run(["api", "pr7"], {}, wt), "pr7", DOTENV_SENDER, DOTENV_RECIPIENT);
    });

    it("takes the last line for a key in one .env", () => {
      writeEnv(sb.repo.dir, `SES_SENDER=first@example.com\n${DOTENV}SES_STAFF_RECIPIENT=${RECIPIENT}\n`);
      const r = run(["api", "pr7"]);
      expectSes(r, "pr7", DOTENV_SENDER, RECIPIENT);
      expect(r.out).not.toContain("first@example.com");
    });

    it.each([
      ["double", '"'],
      ["single", "'"],
    ])("passes %s-quoted .env values to sam unquoted", (_, q) => {
      writeEnv(
        sb.repo.dir,
        `SES_SENDER=${q}${DOTENV_SENDER}${q}\nSES_STAFF_RECIPIENT=${q}${DOTENV_RECIPIENT}${q}\n`,
      );
      expectSes(run(["api", "pr7"]), "pr7", DOTENV_SENDER, DOTENV_RECIPIENT);
    });

    it.each([
      ["api", "dev", "SES_SENDER"],
      ["api", "dev", "SES_STAFF_RECIPIENT"],
      ["all", "dev", "SES_SENDER"],
      ["all", "demo", "SES_STAFF_RECIPIENT"],
      ["api", "demo", "SES_SENDER"],
    ])("refuses %s to %s without %s, before any ssm or sam call", (target, env, missing) => {
      const r = run([target, env], { ...SES_ENV, [missing]: "" });
      expect(r.status).toBe(1);
      expect(r.out).toContain(`SES_SENDER and SES_STAFF_RECIPIENT must be set`);
      expect(r.out).toContain(`to '${env}'`);
      expect(awsOrSam(r.calls)).toEqual([]);
      expectNotPrinted(r);
    });

    it("refuses api to dev with neither value", () => {
      const r = run(["api", "dev"]);
      expect(r.status).toBe(1);
      expect(awsOrSam(r.calls)).toEqual([]);
    });

    it("deploys api to an ephemeral env with neither value, after a note", () => {
      const r = run(["api", "pr7"], { SES_SENDER: SENDER });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("note: SES_SENDER/SES_STAFF_RECIPIENT not set; 'pr7' gets no escalation email");
      const api = overrides(r.calls)["sched-pr7-api"];
      expect(api?.filter((kv) => kv.startsWith("Ses"))).toEqual([]);
      expectNotPrinted(r);
    });

    it("ignores SES values exported in the test runner's own environment", () => {
      vi.stubEnv("SES_SENDER", SENDER);
      vi.stubEnv("SES_STAFF_RECIPIENT", RECIPIENT);
      const r = run(["api", "pr7"]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("note: SES_SENDER/SES_STAFF_RECIPIENT not set");
      expect(overrides(r.calls)["sched-pr7-api"]?.filter((kv) => kv.startsWith("Ses"))).toEqual([]);
    });

    it("needs neither value for a target without api", () => {
      const r = run(["data", "dev"]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toContain("SES_SENDER");
      expect(Object.keys(overrides(r.calls))).toEqual(["sched-dev-data"]);
    });

    it.each(["dev", "pr7"])("passes the values to the api stack's sam deploy only (all %s)", (env) => {
      writeEnv(sb.repo.dir, DOTENV);
      const r = run(["all", env]);
      expectSes(r, env, DOTENV_SENDER, DOTENV_RECIPIENT);
      const byStack = overrides(r.calls);
      expect(Object.keys(byStack)).toEqual(STACKS.map((s) => `sched-${env}-${s}`));
      for (const stack of ["data", "auth", "web"])
        expect(byStack[`sched-${env}-${stack}`]?.filter((kv) => kv.startsWith("Ses"))).toEqual([]);
      for (const call of r.calls.filter((c) => !c.includes(`--stack-name sched-${env}-api `)))
        for (const value of SES_VALUES) expect(call).not.toContain(value);
    });

    it("prints neither value when an unmerged branch deploys to a shared env", () => {
      sb.repo.git("checkout", "-q", "-b", "feat/1-x");
      const r = run(["api", "dev"], SES_ENV);
      expect(r.out).toContain("note: 'dev' is shared; this deploys an unmerged branch");
      expectSes(r, "dev", SENDER, RECIPIENT);
    });
  });

  describe("arguments", () => {
    it.each(BAD_ENV_NAMES)("rejects the env name %s with exit 2 and no aws call", (env) => {
      const r = run(["data", env]);
      expect(r.status).toBe(2);
      expect(r.out).toContain(`invalid env: ${env}`);
      expect(r.calls).toEqual([]);
    });

    it.each(GOOD_ENV_NAMES)("accepts the env name %s (2 and 16 characters are the length bounds)", (env) => {
      const r = run(["data", env]);
      expect(r.status, r.out).toBe(0);
      expect(Object.keys(overrides(r.calls))).toEqual([`sched-${env}-data`]);
    });

    it.each([[[]], [["lambda", "pr7"]], [["lambda"]]])(
      "rejects the stack arguments %j with the usage line",
      (args) => {
        const r = run(args);
        expect(r.status).toBe(2);
        expect(r.out).toContain("usage: ");
        expect(r.out).toContain("<data|auth|api|web|all> [env] [-- Key=Value ...]");
        expect(r.calls).toEqual([]);
      },
    );

    it.each(STACKS)("deploys the one stack %s", (stack) => {
      const r = run([stack, "pr7"], SES_ENV);
      expect(r.status, r.out).toBe(0);
      expect(Object.keys(overrides(r.calls))).toEqual([`sched-pr7-${stack}`]);
    });
  });

  describe("guards", () => {
    it("stops when the credentials are missing or expired, before any ssm or sam call", () => {
      const r = run(["data", "pr7"], { FAKE_STS_FAIL: "1" });
      expect(r.status).toBe(1);
      expect(r.out).toContain("aws sso login --profile sched-dev");
      expect(awsOrSam(r.calls)).toEqual([]);
    });

    it("defaults an ephemeral env to DeletionProtection=disabled, and leaves a protected env's alone", () => {
      expect(overrides(run(["data", "pr7"]).calls)["sched-pr7-data"]).toEqual([
        "Env=pr7",
        "DeletionProtection=disabled",
      ]);
      sb.clearCalls();
      expect(overrides(run(["data", "dev"]).calls)["sched-dev-data"]).toEqual(["Env=dev"]);
    });

    it("lets the caller's own DeletionProtection= win in an ephemeral env", () => {
      const r = run(["data", "pr7", "--", "DeletionProtection=enabled"]);
      expect(overrides(r.calls)["sched-pr7-data"]).toEqual(["Env=pr7", "DeletionProtection=enabled"]);
    });

    it("passes each override only to the templates that declare it", () => {
      const r = run(
        ["all", "dev", "--", "DeletionProtection=disabled", "DailyTurnCap=7", "NotDeclared=1"],
        SES_ENV,
      );
      expect(r.status, r.out).toBe(0);
      expect(overrides(r.calls)).toEqual({
        "sched-dev-data": ["Env=dev", "DeletionProtection=disabled"],
        "sched-dev-auth": ["Env=dev", "DeletionProtection=disabled"],
        "sched-dev-api": [
          "Env=dev",
          "DailyTurnCap=7",
          `SesSender=${SENDER}`,
          `SesStaffRecipient=${RECIPIENT}`,
        ],
        "sched-dev-web": ["Env=dev"],
      });
    });
  });
});
