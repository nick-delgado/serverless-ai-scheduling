/**
 * scripts/teardown.sh (#137), run for real through the shell harness (scripts/test/shell-harness.ts): each test copies
 * the script into a throwaway git repo and runs the copy against a stand-in `aws` that logs every call, finds only the
 * stacks a test names (FAKE_STACKS), fails the delete wait for the one in FAKE_WAIT_FAIL, and fails the one SSM read named
 * in FAKE_SSM_ERROR_NAME with FAKE_SSM_ERROR.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BAD_ENV_NAMES,
  BOOTSTRAP_SSM,
  expectArgumentsRefused,
  GOOD_ENV_NAMES,
  sandbox,
  type Sandbox,
} from "./test/shell-harness";

const ROLE = BOOTSTRAP_SSM["/sched/bootstrap/cfn-exec-role-arn"];
const ALL = "sched-pr7-web sched-pr7-api sched-pr7-auth sched-pr7-data";

let sb: Sandbox;

const run = (args: string[], env: Record<string, string> = {}, input?: string) =>
  sb.run("scripts/teardown.sh", args, { env, input });

const awsCalls = (calls: string[]) => calls.filter((c) => c.startsWith("aws "));
const deletes = (calls: string[]) =>
  calls
    .filter((c) => c.startsWith("aws cloudformation delete-stack"))
    .map((c) => /--stack-name (\S+)/.exec(c)?.[1]);
const emptied = (calls: string[]) => calls.filter((c) => c.startsWith("aws s3 rm"));

function setBucket(bucket: string | undefined): void {
  sb.setSsm({
    ...BOOTSTRAP_SSM,
    ...(bucket === undefined ? {} : { "/sched/pr7/web/bucket-name": bucket }),
  });
}

beforeEach(() => {
  sb = sandbox({ prefix: "sched-teardown-", files: ["scripts/teardown.sh"] });
  setBucket("sched-pr7-web-x");
});

afterEach(() => {
  sb.remove();
});

// Each test spawns git and bash several times; on a busy machine that outruns the 5 s default.
describe("teardown.sh", { timeout: 30_000 }, () => {
  describe("arguments", () => {
    it.each([[[]], ...BAD_ENV_NAMES.map((name) => [[name]])])(
      "rejects %j with exit 2 and no aws call",
      (args) => {
        expectArgumentsRefused(run(args), "usage: ");
      },
    );

    it.each([[["pr7", ""]], [["pr7", "--yse"]], [["pr7", "--yes", "extra"]], [["dev", "--yse"]]])(
      "rejects %j with the usage line, exit 2 and no aws call",
      (args) => {
        expectArgumentsRefused(run(args, { FAKE_STACKS: ALL }), "usage: ");
      },
    );

    it.each(GOOD_ENV_NAMES)("accepts the env name %s (2 and 16 characters are the length bounds)", (env) => {
      const r = run([env]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`nothing to delete: no sched-${env}-* stacks found`);
    });

    it.each(["dev", "demo"])("refuses the protected env %s with exit 1 and no aws call", (env) => {
      const r = run([env, "--yes"], { FAKE_STACKS: `sched-${env}-data` });
      expect(r.status).toBe(1);
      expect(r.out).toContain(`refusing: '${env}' is a protected environment`);
      expect(r.calls).toEqual([]);
    });
  });

  it("stops when the credentials are missing or expired", () => {
    const r = run(["pr7", "--yes"], { FAKE_STS_FAIL: "1", FAKE_STACKS: ALL });
    expect(r.status).toBe(1);
    expect(r.out).toContain("aws sso login --profile sched-dev");
    expect(awsCalls(r.calls)).toEqual(["aws sts get-caller-identity"]);
  });

  it("has nothing to delete when no stack of the env exists", () => {
    const r = run(["pr7", "--yes"], { FAKE_STACKS: "sched-pr8-data" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("nothing to delete: no sched-pr7-* stacks found");
    expect(r.calls.filter((c) => c.startsWith("aws cloudformation describe-stacks"))).toHaveLength(4);
    expect(deletes(r.calls)).toEqual([]);
    expect(emptied(r.calls)).toEqual([]);
  });

  describe("confirmation", () => {
    it("aborts with exit 1 and no delete on a wrong answer", () => {
      const r = run(["pr7"], { FAKE_STACKS: ALL }, "pr8\n");
      expect(r.status).toBe(1);
      expect(deletes(r.calls)).toEqual([]);
      expect(emptied(r.calls)).toEqual([]);
    });

    it("prints aborted on a wrong answer", () => {
      expect(run(["pr7"], { FAKE_STACKS: ALL }, "pr8\n").out).toContain("aborted");
    });

    it.each([
      ["no answer", undefined],
      ["the env name without a newline", "pr7"],
    ])("says no confirmation was given when stdin closes on %s, before any ssm read", (_, input) => {
      const r = run(["pr7"], { FAKE_STACKS: ALL }, input);
      expect(r.status).toBe(1);
      expect(r.out).toContain("aborted: no confirmation given (stdin closed)");
      expect(r.calls.filter((c) => c.startsWith("aws ssm"))).toEqual([]);
      expect(deletes(r.calls)).toEqual([]);
      expect(emptied(r.calls)).toEqual([]);
    });

    it("deletes when the env name is typed", () => {
      const r = run(["pr7"], { FAKE_STACKS: ALL }, "pr7\n");
      expect(r.status, r.out).toBe(0);
      expect(deletes(r.calls)).toHaveLength(4);
    });

    it("--yes skips the question", () => {
      const r = run(["pr7", "--yes"], { FAKE_STACKS: ALL });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`deleted: ${ALL}`);
    });
  });

  it("deletes web, api, auth, data in that order, each with the exec role, waiting for each", () => {
    const r = run(["pr7", "--yes"], {
      FAKE_STACKS: "sched-pr7-data sched-pr7-auth sched-pr7-api sched-pr7-web",
    });
    expect(r.status, r.out).toBe(0);
    const order = ALL.split(" ");
    expect(deletes(r.calls)).toEqual(order);
    expect(r.calls.filter((c) => /cloudformation (delete-stack|wait)/.test(c))).toEqual(
      order.flatMap((name) => [
        `aws cloudformation delete-stack --stack-name ${name} --role-arn ${ROLE}`,
        `aws cloudformation wait stack-delete-complete --stack-name ${name}`,
      ]),
    );
  });

  it("deletes only the stacks that exist", () => {
    const r = run(["pr7", "--yes"], { FAKE_STACKS: "sched-pr7-data sched-pr7-api" });
    expect(r.status, r.out).toBe(0);
    expect(deletes(r.calls)).toEqual(["sched-pr7-api", "sched-pr7-data"]);
    expect(emptied(r.calls)).toEqual([]);
  });

  describe("the site bucket", () => {
    it("empties the env's site bucket before deleting the web stack", () => {
      const r = run(["pr7", "--yes"], { FAKE_STACKS: ALL });
      expect(r.status, r.out).toBe(0);
      const rm = r.calls.indexOf("aws s3 rm s3://sched-pr7-web-x --recursive --only-show-errors");
      expect(rm).toBeGreaterThan(-1);
      expect(rm).toBeLessThan(r.calls.findIndex((c) => c.startsWith("aws cloudformation delete-stack")));
    });

    it.each(["sched-other-web-x", "sched-pr7-webx", "other-sched-pr7-web-x"])(
      "refuses the bucket %s before any s3 rm or delete",
      (bucket) => {
        setBucket(bucket);
        const r = run(["pr7", "--yes"], { FAKE_STACKS: ALL });
        expect(r.status).toBe(1);
        expect(r.out).toContain(`refusing to empty unexpected bucket '${bucket}' for env 'pr7'`);
        expect(emptied(r.calls)).toEqual([]);
        expect(deletes(r.calls)).toEqual([]);
      },
    );

    it("stops with the CLI's error when the bucket read fails for a reason other than not-found", () => {
      const r = run(["pr7", "--yes"], {
        FAKE_STACKS: ALL,
        FAKE_SSM_ERROR:
          "An error occurred (ThrottlingException) when calling the GetParameter operation: Rate exceeded",
        FAKE_SSM_ERROR_NAME: "/sched/pr7/web/bucket-name",
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain("(ThrottlingException) when calling the GetParameter operation: Rate exceeded");
      expect(r.out).toContain("could not read /sched/pr7/web/bucket-name; stopping before any delete.");
      expect(emptied(r.calls)).toEqual([]);
      expect(deletes(r.calls)).toEqual([]);
    });

    it("skips emptying on the real CLI's ParameterNotFound error, and still deletes", () => {
      const r = run(["pr7", "--yes"], {
        FAKE_STACKS: ALL,
        FAKE_SSM_ERROR:
          "An error occurred (ParameterNotFound) when calling the GetParameter operation: Parameter /sched/pr7/web/bucket-name not found.",
        FAKE_SSM_ERROR_NAME: "/sched/pr7/web/bucket-name",
      });
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toContain("ParameterNotFound");
      expect(emptied(r.calls)).toEqual([]);
      expect(deletes(r.calls)).toEqual(ALL.split(" "));
    });

    it.each([
      ["missing", undefined],
      ["None", "None"],
    ])("skips emptying when the bucket parameter is %s, and still deletes", (_, bucket) => {
      setBucket(bucket);
      const r = run(["pr7", "--yes"], { FAKE_STACKS: ALL });
      expect(r.status, r.out).toBe(0);
      expect(emptied(r.calls)).toEqual([]);
      expect(deletes(r.calls)).toEqual(ALL.split(" "));
    });
  });

  it("exits 1 with the redeploy hint when a delete fails, and deletes nothing after it", () => {
    const r = run(["pr7", "--yes"], { FAKE_STACKS: ALL, FAKE_WAIT_FAIL: "sched-pr7-api" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("delete failed for sched-pr7-api");
    expect(r.out).toContain("'scripts/deploy.sh <stack> pr7 -- DeletionProtection=disabled' and retry");
    expect(r.out).toContain("TESTEVENTS");
    expect(deletes(r.calls)).toEqual(["sched-pr7-web", "sched-pr7-api"]);
  });
});
