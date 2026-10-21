/**
 * scripts/deploy.sh (#137), run for real through the shell harness (scripts/test/shell-harness.ts): each test copies the
 * script and the four infra/stacks templates into a throwaway git repo with one commit, writes that repo's .env (never
 * the developer's), and runs the copy against stand-in `aws` and `sam` that log every call. The main-checkout fallback
 * cases add a `git worktree` of that repo. What's checked is the script's exit code, its output, and the stand-in
 * `sam deploy`'s logged arguments. SAM's own NoEcho masking of the SES values is not something these tests can see.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BAD_ENV_NAMES,
  BOOTSTRAP_SSM,
  expectArgumentsRefused,
  GOOD_ENV_NAMES,
  sandbox,
  type Sandbox,
  type ShellRun,
} from "./test/shell-harness";

const STACKS = ["data", "auth", "api", "web"];

// Synthetic values; none of them exists.
const SENDER = "env-sender@example.com";
const RECIPIENT = "env-staff@example.com";
const SES_ENV = { SES_SENDER: SENDER, SES_STAFF_RECIPIENT: RECIPIENT };
const DOTENV_SENDER = "dotenv-sender@example.com";
const DOTENV_RECIPIENT = "dotenv-staff@example.com";
const DOTENV = `SES_SENDER=${DOTENV_SENDER}\nSES_STAFF_RECIPIENT=${DOTENV_RECIPIENT}\n`;
const MAIN_SENDER = "main-sender@example.com";
const MAIN_RECIPIENT = "main-staff@example.com";
const MAIN_DOTENV = `SES_SENDER=${MAIN_SENDER}\nSES_STAFF_RECIPIENT=${MAIN_RECIPIENT}\n`;
const FIRST_SENDER = "first@example.com";
/** r1/Q-1: an unmatched quote that the next line's quote closes, so the sender spans two lines. */
const MULTILINE_DOTENV = `SES_SENDER="${DOTENV_SENDER}'\nSES_STAFF_RECIPIENT="${DOTENV_RECIPIENT}"\n`;
/** Every SES value any test uses, none of which may appear in the script's output. */
const SES_VALUES = [
  SENDER,
  RECIPIENT,
  DOTENV_SENDER,
  DOTENV_RECIPIENT,
  MAIN_SENDER,
  MAIN_RECIPIENT,
  FIRST_SENDER,
];

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

/** The `Ses*` overrides one stack's `sam deploy` got. */
const sesOverrides = (calls: string[], stack: string) =>
  overrides(calls)[stack]?.filter((kv) => kv.startsWith("Ses"));

/**
 * The run succeeded, and the api stack's overrides are exactly Env and these SES values, which the output never shows.
 * The whole list is compared because the stand-in logs `sam $*`, so a value with a space (` # sender` left on by a
 * reader) shows up as extra words rather than a different first word.
 */
function expectSes(r: ShellRun, env: string, sender: string, recipient: string): void {
  expect(r.status, r.out).toBe(0);
  expect(overrides(r.calls)[`sched-${env}-api`]).toEqual([
    `Env=${env}`,
    `SesSender=${sender}`,
    `SesStaffRecipient=${recipient}`,
  ]);
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
      expectSes(r, "pr7", SENDER, RECIPIENT);
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
      writeEnv(sb.repo.dir, `SES_SENDER=${FIRST_SENDER}\n${DOTENV}SES_STAFF_RECIPIENT=${RECIPIENT}\n`);
      expectSes(run(["api", "pr7"]), "pr7", DOTENV_SENDER, RECIPIENT);
    });

    it("falls back to the main checkout's .env for a key the worktree's .env doesn't have", () => {
      writeEnv(sb.repo.dir, MAIN_DOTENV);
      const wt = worktree();
      writeEnv(wt, `SES_STAFF_RECIPIENT=${DOTENV_RECIPIENT}\n`);
      expectSes(run(["api", "pr7"], {}, wt), "pr7", MAIN_SENDER, DOTENV_RECIPIENT);
    });

    // #257: the forms util.parseEnv reads as the bare value, which the earlier line-based reader didn't.
    it.each([
      ["CRLF line endings", `SES_SENDER=${DOTENV_SENDER}\r\nSES_STAFF_RECIPIENT=${DOTENV_RECIPIENT}\r\n`],
      [
        "an inline # comment",
        `SES_SENDER=${DOTENV_SENDER} # sender\nSES_STAFF_RECIPIENT=${DOTENV_RECIPIENT}\n`,
      ],
      [
        "an export prefix",
        `export SES_SENDER=${DOTENV_SENDER}\nexport SES_STAFF_RECIPIENT=${DOTENV_RECIPIENT}\n`,
      ],
      ["spaces around =", `SES_SENDER = ${DOTENV_SENDER}\nSES_STAFF_RECIPIENT  =  ${DOTENV_RECIPIENT}\n`],
    ])("reads a .env with %s as the bare values", (_, text) => {
      writeEnv(sb.repo.dir, text);
      expectSes(run(["api", "pr7"]), "pr7", DOTENV_SENDER, DOTENV_RECIPIENT);
    });

    it("passes a value with an unmatched quote on its own line to sam as written", () => {
      writeEnv(sb.repo.dir, `SES_STAFF_RECIPIENT=${DOTENV_RECIPIENT}\nSES_SENDER="${DOTENV_SENDER}'\n`);
      expectSes(run(["api", "pr7"]), "pr7", `"${DOTENV_SENDER}'`, DOTENV_RECIPIENT);
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

    // r1/Q-1 (a): an unmatched quote that a later line closes swallows that line into a two-line value.
    it.each(["dev", "pr7"])(
      "refuses api to %s when a .env value spans lines, before any ssm or sam call",
      (env) => {
        writeEnv(sb.repo.dir, MULTILINE_DOTENV);
        const r = run(["api", env]);
        expect(r.status).toBe(1);
        expect(r.out).toContain("SES_SENDER spans more than one line");
        expect(r.out).toContain("an unmatched quote");
        expect(r.out).not.toContain("must be set");
        expect(awsOrSam(r.calls)).toEqual([]);
        expectNotPrinted(r);
      },
    );

    it.each([
      ["SES_SENDER", "\r", "SES_STAFF_RECIPIENT"],
      ["SES_SENDER", "\n", "SES_STAFF_RECIPIENT"],
      ["SES_STAFF_RECIPIENT", "\r", "SES_SENDER"],
      ["SES_STAFF_RECIPIENT", "\n", "SES_SENDER"],
    ])("refuses an environment %s containing %j, naming only that key", (key, char, other) => {
      const r = run(["api", "pr7"], { ...SES_ENV, [key]: `${SES_ENV[key as keyof typeof SES_ENV]}${char}x` });
      expect(r.status).toBe(1);
      expect(r.out).toContain(`${key} spans more than one line`);
      expect(r.out).not.toContain(`${other} spans`);
      expect(r.out).not.toContain(`${other} ${key}`);
      expect(awsOrSam(r.calls)).toEqual([]);
      expectNotPrinted(r);
    });

    it("refuses a worktree .env value that spans lines rather than falling back to the main checkout's", () => {
      writeEnv(sb.repo.dir, MAIN_DOTENV);
      const wt = worktree();
      writeEnv(wt, MULTILINE_DOTENV);
      const r = run(["api", "pr7"], {}, wt);
      expect(r.status).toBe(1);
      expect(r.out).toContain("SES_SENDER spans more than one line");
      expect(awsOrSam(r.calls)).toEqual([]);
      expectNotPrinted(r);
    });

    it("doesn't refuse a .env value that spans lines for a target without api", () => {
      writeEnv(sb.repo.dir, MULTILINE_DOTENV);
      const r = run(["data", "dev"]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toContain("spans more than one line");
      expect(Object.keys(overrides(r.calls))).toEqual(["sched-dev-data"]);
      expectNotPrinted(r);
    });

    it("doesn't refuse a .env value that spans lines when the environment overrides it", () => {
      writeEnv(sb.repo.dir, MULTILINE_DOTENV);
      expectSes(run(["api", "pr7"], SES_ENV), "pr7", SENDER, RECIPIENT);
    });

    it("stops with Node's error, naming no value, when a .env can't be read", () => {
      writeEnv(sb.repo.dir, DOTENV);
      chmodSync(join(sb.repo.dir, ".env"), 0o000);
      const r = run(["api", "pr7"]);
      expect(r.status).toBe(1);
      expect(r.out).toContain("EACCES");
      expect(awsOrSam(r.calls)).toEqual([]);
      expectNotPrinted(r);
    });

    it("refuses api to dev with neither value", () => {
      const r = run(["api", "dev"]);
      expect(r.status).toBe(1);
      expect(awsOrSam(r.calls)).toEqual([]);
      expectNotPrinted(r);
    });

    it("deploys api to an ephemeral env with neither value, after a note", () => {
      const r = run(["api", "pr7"], { SES_SENDER: SENDER });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("note: SES_SENDER/SES_STAFF_RECIPIENT not set; 'pr7' gets no escalation email");
      expect(sesOverrides(r.calls, "sched-pr7-api")).toEqual([]);
      expectNotPrinted(r);
    });

    it("ignores SES values exported in the test runner's own environment", () => {
      vi.stubEnv("SES_SENDER", SENDER);
      vi.stubEnv("SES_STAFF_RECIPIENT", RECIPIENT);
      const r = run(["api", "pr7"]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("note: SES_SENDER/SES_STAFF_RECIPIENT not set");
      expect(sesOverrides(r.calls, "sched-pr7-api")).toEqual([]);
      expectNotPrinted(r);
    });

    it("needs neither value for a target without api", () => {
      const r = run(["data", "dev"]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toContain("SES_SENDER");
      expect(Object.keys(overrides(r.calls))).toEqual(["sched-dev-data"]);
      expectNotPrinted(r);
    });

    it.each(["dev", "pr7"])("passes the values to the api stack's sam deploy only (all %s)", (env) => {
      writeEnv(sb.repo.dir, DOTENV);
      const r = run(["all", env]);
      expectSes(r, env, DOTENV_SENDER, DOTENV_RECIPIENT);
      const byStack = overrides(r.calls);
      expect(Object.keys(byStack)).toEqual(STACKS.map((s) => `sched-${env}-${s}`));
      for (const stack of ["data", "auth", "web"])
        expect(sesOverrides(r.calls, `sched-${env}-${stack}`)).toEqual([]);
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
      expectArgumentsRefused(run(["data", env]), `invalid env: ${env}`);
    });

    it.each(GOOD_ENV_NAMES)("accepts the env name %s (2 and 16 characters are the length bounds)", (env) => {
      const r = run(["data", env]);
      expect(r.status, r.out).toBe(0);
      expect(Object.keys(overrides(r.calls))).toEqual([`sched-${env}-data`]);
    });

    it.each([
      [[]],
      [["lambda", "pr7"]],
      [["lambda"]],
      [["data", "pr7", "DeletionProtection=enabled"]],
      [["data auth", "pr7"]],
      [[" data", "pr7"]],
    ])("rejects the stack arguments %j with the usage line", (args) => {
      expectArgumentsRefused(run(args), "<data|auth|api|web|all> [env] [-- Key=Value ...]");
    });

    it('still reads an invalid env first: "data auth" Dev is refused as an invalid env', () => {
      expectArgumentsRefused(run(["data auth", "Dev"]), "invalid env: Dev");
    });

    it("accepts a bare -- with nothing after it", () => {
      const r = run(["data", "pr7", "--"]);
      expect(r.status, r.out).toBe(0);
      expect(overrides(r.calls)["sched-pr7-data"]).toEqual(["Env=pr7", "DeletionProtection=disabled"]);
    });

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
  describe("the reviewer access page's secret and switch (#357)", () => {
    // Synthetic: Cloudflare's documented always-passes test secret, and distinct stand-ins for the .env sources.
    const SECRET = "1x0000000000000000000000000000000AA";
    const DOTENV_SECRET = "dotenv-turnstile-secret-value";
    const HOST = "TurnstileExpectedHostname=localhost";
    const PAGE_ON = ["--", "RequestAccess=on", HOST];
    const noSecretPrinted = (r: ShellRun) => {
      for (const value of [SECRET, DOTENV_SECRET]) expect(r.out).not.toContain(value);
    };

    it("passes TurnstileSecret to the api stack from the environment, after the SES values, and never prints it", () => {
      const r = run(["api", "pr7", ...PAGE_ON], { ...SES_ENV, TURNSTILE_SECRET: SECRET });
      expect(r.status, r.out).toBe(0);
      expect(overrides(r.calls)["sched-pr7-api"]).toEqual([
        "Env=pr7",
        "RequestAccess=on",
        HOST,
        `SesSender=${SENDER}`,
        `SesStaffRecipient=${RECIPIENT}`,
        `TurnstileSecret=${SECRET}`,
      ]);
      noSecretPrinted(r);
    });

    it("reads TURNSTILE_SECRET from .env, and prefers the environment over it", () => {
      writeEnv(sb.repo.dir, `${DOTENV}TURNSTILE_SECRET=${DOTENV_SECRET}\n`);
      const fromFile = run(["api", "pr7", ...PAGE_ON]);
      expect(overrides(fromFile.calls)["sched-pr7-api"]).toContain(`TurnstileSecret=${DOTENV_SECRET}`);
      noSecretPrinted(fromFile);
      sb.clearCalls();
      const both = run(["api", "pr7", ...PAGE_ON], { TURNSTILE_SECRET: SECRET });
      expect(overrides(both.calls)["sched-pr7-api"]).toContain(`TurnstileSecret=${SECRET}`);
      expect(overrides(both.calls)["sched-pr7-api"]).not.toContain(`TurnstileSecret=${DOTENV_SECRET}`);
    });

    it("passes the secret to the api stack only, and RequestAccess only to the template that declares it", () => {
      const r = run(["all", "pr7", ...PAGE_ON], { ...SES_ENV, TURNSTILE_SECRET: SECRET });
      expect(r.status, r.out).toBe(0);
      const all = overrides(r.calls);
      expect(all["sched-pr7-data"]).toEqual(["Env=pr7", "DeletionProtection=disabled"]);
      expect(all["sched-pr7-auth"]).toEqual(["Env=pr7", "DeletionProtection=disabled"]);
      expect(all["sched-pr7-web"]).toEqual(["Env=pr7"]);
      expect(all["sched-pr7-api"]).toContain("RequestAccess=on");
      expect(all["sched-pr7-api"]).toContain(`TurnstileSecret=${SECRET}`);
    });

    it("leaves the api overrides alone when the page is off and no secret is set", () => {
      expectSes(run(["api", "pr7"], SES_ENV), "pr7", SENDER, RECIPIENT);
    });

    it("refuses RequestAccess=on without a secret, before any ssm or sam call", () => {
      const r = run(["api", "pr7", ...PAGE_ON], SES_ENV);
      expect(r.status).toBe(1);
      expect(r.out).toContain("TURNSTILE_SECRET must be set");
      expect(r.out).toContain("RequestAccess=on");
      expect(awsOrSam(r.calls)).toEqual([]);
    });

    it.each(["dev", "e2e"])("refuses RequestAccess=on for %s even with a secret and a hostname", (env) => {
      const r = run(["api", env, ...PAGE_ON], { ...SES_ENV, TURNSTILE_SECRET: SECRET });
      expect(r.status).toBe(1);
      expect(r.out).toContain(`refusing RequestAccess=on for '${env}'`);
      expect(r.out).toContain("stays off on dev and e2e");
      expect(awsOrSam(r.calls)).toEqual([]);
      noSecretPrinted(r);
    });

    // The demo env turns the page on through the template's Env clause, so deploy.sh asks for what the page needs
    // whether or not RequestAccess=on is passed (#357, part 2; decision 97fb801/SPEC-2 (a) and SPEC-3 (b)).
    it("deploys demo's api stack with the secret and the hostname, with no RequestAccess switch", () => {
      const r = run(["api", "demo", "--", "TurnstileExpectedHostname=d111.example"], {
        ...SES_ENV,
        TURNSTILE_SECRET: SECRET,
      });
      expect(r.status, r.out).toBe(0);
      expect(overrides(r.calls)["sched-demo-api"]).toEqual([
        "Env=demo",
        "TurnstileExpectedHostname=d111.example",
        `SesSender=${SENDER}`,
        `SesStaffRecipient=${RECIPIENT}`,
        `TurnstileSecret=${SECRET}`,
      ]);
      noSecretPrinted(r);
    });

    it("accepts RequestAccess=on for demo too, with the secret and the hostname", () => {
      const r = run(["api", "demo", ...PAGE_ON], { ...SES_ENV, TURNSTILE_SECRET: SECRET });
      expect(r.status, r.out).toBe(0);
      expect(overrides(r.calls)["sched-demo-api"]).toContain("RequestAccess=on");
    });

    it("refuses demo's api stack without a secret, before any ssm or sam call", () => {
      const r = run(["api", "demo", "--", HOST], SES_ENV);
      expect(r.status).toBe(1);
      expect(r.out).toContain("TURNSTILE_SECRET must be set");
      expect(r.out).toContain("the demo env");
      expect(awsOrSam(r.calls)).toEqual([]);
    });

    it("refuses demo's api stack without TurnstileExpectedHostname, before any ssm or sam call", () => {
      const r = run(["api", "demo"], { ...SES_ENV, TURNSTILE_SECRET: SECRET });
      expect(r.status).toBe(1);
      expect(r.out).toContain("TurnstileExpectedHostname must be passed as one hostname");
      expect(r.out).toContain("the demo env");
      expect(awsOrSam(r.calls)).toEqual([]);
      noSecretPrinted(r);
    });

    it("refuses RequestAccess=on on an ephemeral env without TurnstileExpectedHostname", () => {
      const r = run(["api", "pr7", "--", "RequestAccess=on"], { ...SES_ENV, TURNSTILE_SECRET: SECRET });
      expect(r.status).toBe(1);
      expect(r.out).toContain("TurnstileExpectedHostname must be passed as one hostname");
      expect(r.out).toContain("RequestAccess=on");
      expect(awsOrSam(r.calls)).toEqual([]);
    });

    it.each(["", "a/b", "a b", ".leading", "trailing.", "-dash", "d111.example\nx"])(
      "refuses the hostname %j as not one hostname",
      (host) => {
        const r = run(["api", "pr7", "--", "RequestAccess=on", `TurnstileExpectedHostname=${host}`], {
          ...SES_ENV,
          TURNSTILE_SECRET: SECRET,
        });
        expect(r.status).toBe(1);
        expect(r.out).toContain("TurnstileExpectedHostname must be passed as one hostname");
        expect(awsOrSam(r.calls)).toEqual([]);
      },
    );

    it("reads the hostname only from the parameter of that exact name, not from one that shares its prefix", () => {
      const r = run(["api", "pr7", "--", "RequestAccess=on", "TurnstileExpectedHostnameX=localhost"], {
        ...SES_ENV,
        TURNSTILE_SECRET: SECRET,
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain("TurnstileExpectedHostname must be passed as one hostname");
    });

    it("does not ask for a hostname when the page is off, and still deploys dev with one given", () => {
      const r = run(["api", "dev", "--", HOST], { ...SES_ENV, TURNSTILE_SECRET: SECRET });
      expect(r.status, r.out).toBe(0);
      expect(overrides(r.calls)["sched-dev-api"]).toContain(HOST);
    });

    it("still deploys dev without the page switch, passing a secret it was given", () => {
      const r = run(["api", "dev"], { ...SES_ENV, TURNSTILE_SECRET: SECRET });
      expect(r.status, r.out).toBe(0);
      expect(overrides(r.calls)["sched-dev-api"]).not.toContain("RequestAccess=on");
      expect(overrides(r.calls)["sched-dev-api"]).toContain(`TurnstileSecret=${SECRET}`);
      noSecretPrinted(r);
    });

    it("refuses a secret that spans lines, naming only the key", () => {
      const r = run(["api", "pr7"], { ...SES_ENV, TURNSTILE_SECRET: `${SECRET}\nx` });
      expect(r.status).toBe(1);
      expect(r.out).toContain("TURNSTILE_SECRET spans more than one line");
      expect(r.out).toMatch(/^TURNSTILE_SECRET spans more than one line/m);
      // Neither SES key is named, before it (the order deploy.sh prints) or after it.
      for (const other of ["SES_SENDER", "SES_STAFF_RECIPIENT"]) {
        expect(r.out).not.toContain(`${other} spans`);
        expect(r.out).not.toContain(`${other} TURNSTILE_SECRET`);
        expect(r.out).not.toContain(`TURNSTILE_SECRET ${other}`);
      }
      expect(awsOrSam(r.calls)).toEqual([]);
      noSecretPrinted(r);
    });

    it("does not look for a secret when the target has no api stack", () => {
      const r = run(["data", "pr7", ...PAGE_ON], {});
      expect(r.status, r.out).toBe(0);
      expect(overrides(r.calls)["sched-pr7-data"]).toEqual(["Env=pr7", "DeletionProtection=disabled"]);
    });
  });
});
