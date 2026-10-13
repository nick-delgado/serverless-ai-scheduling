/**
 * The shell harness's guard (#137, AC3): a run can't reach a real `aws`, `sam` or `npm`. Each case removes one stand-in
 * and puts an impostor of that name first on the parent's PATH, where an inherited PATH would find it; the run throws
 * and the impostor never runs. With every stand-in present, the same run passes and still never reaches it.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sandbox, type Sandbox, type StandIn } from "./shell-harness";

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

const SSM = {
  "/sched/bootstrap/cfn-exec-role-arn": "arn:aws:iam::000000000000:role/sched-cfn-exec-test",
  "/sched/bootstrap/artifact-bucket": "sched-test-artifacts",
  "/sched/pr7/auth/user-pool-id": "us-east-1_TESTPOOL1",
  "/sched/pr7/auth/spa-client-id": "testclient0000000000000000",
  "/sched/pr7/auth/identity-pool-id": "us-east-1:00000000-0000-4000-8000-000000000000",
  "/sched/pr7/web/bucket-name": "sched-pr7-web-000000000000",
  "/sched/pr7/web/distribution-id": "ETESTDIST",
  "/sched/pr7/web/domain": "dtest.cloudfront.example",
};

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

  it("a run that calls a command off the allow-list throws", () => {
    sb = sandbox({
      prefix: "sched-guard-",
      files: ["scripts/deploy.sh", "infra/stacks/data.yaml"],
      standIns: { sam: `#!/usr/bin/env bash\nnot-on-the-allow-list-137\n` },
    });
    sb.setSsm(SSM);
    expect(() => sb?.run("scripts/deploy.sh", ["data", "pr7"])).toThrow("command not found");
  });
});
