/**
 * The shell scripts' test harness (#137, shared by deploy.test.ts, teardown.test.ts and deploy-web.test.ts). Each test
 * gets a sandbox: a temporary directory holding a throwaway git repo with copies of the checkout's files (copied per
 * test, so an `npm run mutate` edit to the checkout's script reaches the run), stand-in `aws`, `sam` and `npm`
 * commands that log every call, and the environment the scripts run with, built from scratch.
 *
 * The guard against reaching real AWS: a run's PATH is the stand-ins' directory, then a directory of links to the
 * TOOLS allow-list resolved from the parent's PATH. `aws`, `sam` and `npm` are never on that list, so a missing stand-in
 * leaves the name unresolvable instead of finding the real command, and the run throws when any stand-in is missing or
 * the output says `command not found`, so the test fails. Nothing else of the parent's environment reaches the
 * scripts: not a developer's SES_* values, AWS credentials or GIT_DIR, and HOME is the sandbox.
 */
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { gitRepo, type TestRepo } from "./git-repo";

/** The checkout these tests live in; files are copied from here. */
export const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const STAND_INS = ["aws", "sam", "npm"] as const;
export type StandIn = (typeof STAND_INS)[number];

/** Everything deploy.sh, teardown.sh, deploy-web.sh and the stand-ins call that isn't a bash builtin. */
export const TOOLS = [
  "bash",
  "git",
  "dirname",
  "sed",
  "tail",
  "tr",
  "awk",
  "cat",
  "rm",
  "mkdir",
  "find",
  "head",
  "grep",
];

/** Env names every script's check rejects, and the two at its length bounds that it lets past. */
export const BAD_ENV_NAMES = ["Dev", "dev_x", "d", "a2345678901234567"];
export const GOOD_ENV_NAMES = ["ab", "a234567890123456"];

/**
 * Logs each call to $FAKE_LOG. `sts` fails with FAKE_STS_FAIL; `ssm get-parameter` answers from $FAKE_SSM_DIR (one
 * file per name) or fails with FAKE_SSM_ERROR; `cloudformation describe-stacks` finds only the stacks in FAKE_STACKS
 * (space-separated names); `cloudformation wait` fails for the stack named in FAKE_WAIT_FAIL.
 */
export const FAKE_AWS = `#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
case "$1 $2" in
  "sts get-caller-identity") echo "identity profile=$AWS_PROFILE region=$AWS_REGION" >> "$FAKE_LOG"; [[ -n "\${FAKE_STS_FAIL:-}" ]] && exit 255; echo '{}' ;;
  "ssm get-parameter")
    [[ -n "\${FAKE_SSM_ERROR:-}" ]] && { echo "$FAKE_SSM_ERROR" >&2; exit 254; }
    f="$FAKE_SSM_DIR/$(printf '%s' "$4" | tr / _)"
    [[ -f "$f" ]] || { echo "ParameterNotFound" >&2; exit 254; }
    cat "$f" ;;
  "cloudfront create-invalidation") echo "ITESTINVALIDATION" ;;
  "cloudformation describe-stacks") [[ " \${FAKE_STACKS:-} " == *" $4 "* ]] || { echo "Stack with id $4 does not exist" >&2; exit 254; } ;;
  "cloudformation wait") [[ "$5" == "\${FAKE_WAIT_FAIL:-}" ]] && { echo "Waiter StackDeleteComplete failed" >&2; exit 255; } ;;
  "cloudformation describe-stack-events") echo "TESTEVENTS" ;;
esac
exit 0
`;

/** Logs each call to $FAKE_LOG and prints nothing, so a value it's given never reaches the script's output. */
export const FAKE_SAM = `#!/usr/bin/env bash
echo "sam $*" >> "$FAKE_LOG"
`;

/** deploy.sh and teardown.sh never run npm; this one is there so that a call can't reach the real one. */
export const FAKE_NPM_UNUSED = `#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_LOG"
exit 1
`;

/** The first executable named `name` on `path`, like `command -v`. */
export function which(name: string, path: string): string | undefined {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here; try the next directory
    }
  }
  return undefined;
}

export interface ShellRun {
  status: number | null;
  /** stdout then stderr. */
  out: string;
  /** Every line the stand-ins logged so far in this test. */
  calls: string[];
}

export interface RunOptions {
  /** Added to the scripts' environment (HOME, PATH and the stand-ins' variables are already set). */
  env?: Record<string, string>;
  /** stdin; without it the script reads end-of-file. */
  input?: string;
  /** The checkout whose copy of the script runs; the sandbox repo by default (a worktree of it, for example). */
  root?: string;
}

export interface Sandbox {
  /** The test's temporary directory (real path): the repo, stand-ins, call log and HOME are all inside it. */
  dir: string;
  repo: TestRepo;
  /** Replaces the `aws ssm get-parameter` answers. */
  setSsm: (values: Record<string, string>) => void;
  /** Writes a stand-in, or removes it when `body` is undefined. */
  standIn: (name: StandIn, body: string | undefined) => void;
  calls: () => string[];
  clearCalls: () => void;
  /** Runs `script` (relative to the checkout) with bash; throws when a stand-in is missing or a command wasn't found. */
  run: (script: string, args: string[], options?: RunOptions) => ShellRun;
  remove: () => void;
}

export interface SandboxOptions {
  prefix: string;
  /** Paths relative to the checkout, copied into the repo, which then gets one commit. */
  files: string[];
  /** Extra files to write into the repo before the commit. */
  write?: Record<string, string>;
  /** Stand-in bodies replacing the defaults. */
  standIns?: Partial<Record<StandIn, string>>;
  /** The PATH the TOOLS are resolved from; the parent's by default. */
  parentPath?: string;
}

/** The script refused its arguments: exit 2, `message` printed, and no stand-in called. */
export function expectArgumentsRefused(r: ShellRun, message: string): void {
  expect(r.status).toBe(2);
  expect(r.out).toContain(message);
  expect(r.calls).toEqual([]);
}

export function sandbox(options: SandboxOptions): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), options.prefix)));
  const bin = join(dir, "bin");
  const tools = join(dir, "tools");
  const log = join(dir, "calls.log");
  const ssmDir = join(dir, "ssm");
  mkdirSync(bin);
  mkdirSync(tools);

  const parentPath = options.parentPath ?? process.env.PATH ?? "";
  for (const tool of TOOLS) {
    const found = which(tool, parentPath);
    if (found === undefined) throw new Error(`shell harness: ${tool} is not on the parent's PATH`);
    symlinkSync(found, join(tools, tool));
  }
  const bash = join(tools, "bash");

  const standIn = (name: StandIn, body: string | undefined) => {
    const file = join(bin, name);
    if (body === undefined) {
      rmSync(file, { force: true });
      return;
    }
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  };
  const defaults: Record<StandIn, string> = { aws: FAKE_AWS, sam: FAKE_SAM, npm: FAKE_NPM_UNUSED };
  for (const name of STAND_INS) standIn(name, options.standIns?.[name] ?? defaults[name]);

  const repo = gitRepo(options.prefix, join(dir, "repo"));
  for (const file of options.files) {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    copyFileSync(join(CHECKOUT, file), join(repo.dir, file));
  }
  for (const [file, text] of Object.entries(options.write ?? {})) repo.write(file, text);
  repo.commit("init");

  const setSsm = (values: Record<string, string>) => {
    rmSync(ssmDir, { recursive: true, force: true });
    mkdirSync(ssmDir);
    for (const [name, value] of Object.entries(values))
      writeFileSync(join(ssmDir, name.replaceAll("/", "_")), value);
  };
  setSsm({});
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

  const run = (script: string, args: string[], runOptions: RunOptions = {}): ShellRun => {
    const r = spawnSync(bash, [join(runOptions.root ?? repo.dir, script), ...args], {
      cwd: dir,
      encoding: "utf8",
      input: runOptions.input ?? "",
      env: {
        PATH: `${bin}${delimiter}${tools}`,
        HOME: dir,
        FAKE_LOG: log,
        FAKE_SSM_DIR: ssmDir,
        ...runOptions.env,
      },
    });
    const out = r.stdout + r.stderr;
    const missing = STAND_INS.filter((name) => !existsSync(join(bin, name)));
    if (missing.length > 0 || out.includes("command not found"))
      throw new Error(
        `shell harness: no stand-in for ${missing.join(", ") || "a command"}; the run could have reached a real one ` +
          `(exit ${String(r.status)}):\n${out}`,
      );
    return { status: r.status, out, calls: calls() };
  };

  return {
    dir,
    repo,
    setSsm,
    standIn,
    calls,
    clearCalls: () => rmSync(log, { force: true }),
    run,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
