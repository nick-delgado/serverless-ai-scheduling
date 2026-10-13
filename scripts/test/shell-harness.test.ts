/**
 * The shell harness's guard (#137, AC3): a run can't reach a real `aws`, `sam` or `npm`. Each case removes one stand-in
 * and puts an impostor of that name first on the parent's PATH, where an inherited PATH would find it; the run throws
 * and the impostor never runs. With every stand-in present, the same run passes and still never reaches it.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitRepo } from "./git-repo";
import { BOOTSTRAP_SSM, sandbox, type Sandbox, type StandIn, webSsm, which } from "./shell-harness";

let impostors = "";
let sb: Sandbox | undefined;

beforeEach(() => {
  impostors = realpathSync(mkdtempSync(join(tmpdir(), "sched-impostors-")));
  mkdirSync(join(impostors, "bin"));
});

afterEach(() => {
  sb?.remove();
  sb = undefined;
  rmSync(impostors, { recursive: true, force: true });
});

function impostor(name: StandIn): string {
  const marker = join(impostors, `${name}.called`);
  writeFileSync(join(impostors, "bin", name), `#!/bin/sh\n: > "${marker}"\nexit 0\n`);
  chmodSync(join(impostors, "bin", name), 0o755);
  return marker;
}

// A run of each script that reaches the command: deploy.sh calls aws and sam; deploy-web.sh calls npm.
const CASES: [StandIn, string, string[]][] = [
  ["aws", "scripts/deploy.sh", ["data", "pr7"]],
  ["sam", "scripts/deploy.sh", ["data", "pr7"]],
  ["npm", "scripts/deploy-web.sh", ["pr7", "--dry-run"]],
];

const SSM = { ...BOOTSTRAP_SSM, ...webSsm("pr7") };

// An npm that builds what deploy-web.sh checks for, so the run with every stand-in present passes.
const BUILDING_NPM = `#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_LOG"
mkdir -p apps/web/dist/assets
echo '<!doctype html>' > apps/web/dist/index.html
echo "$VITE_USER_POOL_ID $VITE_IDENTITY_POOL_ID" > apps/web/dist/assets/index.js
`;

describe("shell harness guard", { timeout: 30_000 }, () => {
  it.each(CASES)(
    "a run without the %s stand-in fails and never reaches an impostor on the parent's PATH",
    (name, script, args) => {
      const marker = impostor(name);
      sb = sandbox({
        prefix: "sched-guard-",
        files: [script, "infra/stacks/data.yaml"],
        write: { ".gitignore": "apps/web/dist/\n" },
        standIns: { npm: BUILDING_NPM },
        parentPath: `${join(impostors, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      });
      sb.setSsm(SSM);

      const passed = sb.run(script, args);
      expect(passed.status, passed.out).toBe(0);
      expect(passed.calls.some((c) => c.startsWith(`${name} `))).toBe(true);
      expect(existsSync(marker)).toBe(false);

      sb.standIn(name, undefined);
      expect(() => sb?.run(script, args)).toThrow(`no stand-in for ${name}`);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("a run that calls a real command off the allow-list (uname) throws", () => {
    expect(which("uname", process.env.PATH ?? "")).toBeDefined();
    sb = sandbox({
      prefix: "sched-guard-",
      files: ["scripts/deploy.sh", "infra/stacks/data.yaml"],
      standIns: { sam: `#!/usr/bin/env bash\nuname\n` },
    });
    sb.setSsm(SSM);
    expect(() => sb?.run("scripts/deploy.sh", ["data", "pr7"])).toThrow("command not found");
  });

  it("a tool missing from the parent's PATH stops the sandbox before any run, and leaves no directory behind", () => {
    const prefix = `sched-missing-tool-${String(process.pid)}-`;
    expect(() => sandbox({ prefix, files: [], parentPath: join(impostors, "bin") })).toThrow(
      "shell harness: bash is not on the parent's PATH",
    );
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix))).toEqual([]);
  });
});

// r1/Q-1: every run's checkout is the sandbox repo or a worktree of it, so its .env fallback stays in the sandbox.
describe("shell harness checkout check", { timeout: 30_000 }, () => {
  const SCRIPT = "scripts/teardown.sh";

  beforeEach(() => {
    sb = sandbox({ prefix: "sched-root-", files: [SCRIPT] });
  });

  /** A copy of the script at `root`, a git checkout. */
  const copyTo = (root: string) => {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(join(sb?.repo.dir ?? "", SCRIPT), join(root, SCRIPT));
  };

  it("runs the sandbox repo's copy and a worktree's", () => {
    const wt = join(sb?.dir ?? "", "wt");
    sb?.repo.git("worktree", "add", "-q", "-b", "wt", wt);
    expect(sb?.run(SCRIPT, ["ab"]).status).toBe(0);
    expect(sb?.run(SCRIPT, ["ab"], { root: wt }).status).toBe(0);
  });

  it("refuses a checkout outside the sandbox", () => {
    const outside = gitRepo("sched-outside-");
    try {
      copyTo(outside.dir);
      expect(() => sb?.run(SCRIPT, ["ab"], { root: outside.dir })).toThrow(
        "is not a real path inside the sandbox",
      );
    } finally {
      outside.remove();
    }
  });

  it("refuses a path into the sandbox that isn't real (a symlink)", () => {
    const link = join(sb?.dir ?? "", "link");
    symlinkSync(sb?.repo.dir ?? "", link);
    expect(() => sb?.run(SCRIPT, ["ab"], { root: link })).toThrow("is not a real path inside the sandbox");
  });

  it("refuses a checkout inside the sandbox whose main checkout is another repo", () => {
    const outside = gitRepo("sched-outside-");
    try {
      outside.write("README", "x");
      outside.commit("init");
      const wt = join(sb?.dir ?? "", "foreign");
      outside.git("worktree", "add", "-q", "-b", "foreign", wt);
      copyTo(wt);
      expect(() => sb?.run(SCRIPT, ["ab"], { root: wt })).toThrow("not the sandbox repo");
    } finally {
      outside.remove();
    }
  });
});
