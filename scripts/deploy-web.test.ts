/**
 * scripts/deploy-web.sh (#100), run for real against stand-in `aws` and `npm` commands on PATH. Each
 * test copies the script into a throwaway git repo, so its repo_root, working-tree check and build
 * output are that repo's. The stand-ins log every call; `aws ssm get-parameter` answers from a
 * per-test map, and `npm` writes a fake build that embeds the VITE_* values it was given.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "deploy-web.sh");

// Synthetic values in the shape the stacks publish; none of them exists.
const SSM: Record<string, string> = {
  "/sched/dev/auth/user-pool-id": "us-east-1_TESTPOOL1",
  "/sched/dev/auth/spa-client-id": "testclient0000000000000000",
  "/sched/dev/auth/identity-pool-id": "us-east-1:00000000-0000-4000-8000-000000000000",
  "/sched/dev/web/bucket-name": "sched-dev-web-000000000000",
  "/sched/dev/web/distribution-id": "ETESTDIST",
  "/sched/dev/web/domain": "dtest.cloudfront.example",
};

const FAKE_AWS = `#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
case "$1 $2" in
  "sts get-caller-identity") echo "identity profile=$AWS_PROFILE region=$AWS_REGION" >> "$FAKE_LOG"; [[ -n "\${FAKE_STS_FAIL:-}" ]] && exit 255; echo '{}' ;;
  "ssm get-parameter")
    f="$FAKE_SSM_DIR/$(printf '%s' "$4" | tr / _)"
    [[ -f "$f" ]] || { echo "ParameterNotFound" >&2; exit 254; }
    cat "$f" ;;
  "cloudfront create-invalidation") echo "ITESTINVALIDATION" ;;
esac
exit 0
`;

// Writes apps/web/dist like Vite does, unless FAKE_BUILD says otherwise.
const FAKE_NPM = `#!/usr/bin/env bash
echo "npm $* VITE_USER_POOL_ID=\${VITE_USER_POOL_ID-unset} VITE_SPA_CLIENT_ID=\${VITE_SPA_CLIENT_ID-unset} VITE_IDENTITY_POOL_ID=\${VITE_IDENTITY_POOL_ID-unset}" >> "$FAKE_LOG"
[[ "\${FAKE_BUILD:-}" == "none" ]] && exit 0
mkdir -p apps/web/dist/assets
echo '<!doctype html><script src="/assets/index-abc123.js"></script>' > apps/web/dist/index.html
[[ "\${FAKE_BUILD:-}" == "no-assets" ]] && exit 0
pool="$VITE_USER_POOL_ID"
[[ "\${FAKE_BUILD:-}" == "no-pool" ]] && pool=""
echo "const c={userPoolId:\\"$pool\\"}" > apps/web/dist/assets/index-abc123.js
`;

let dir = "";
let repo = "";
let log = "";
let ssmDir = "";

function git(...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
}

function head(): string {
  return spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

function without(name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(SSM).filter(([key]) => key !== name));
}

function setSsm(values: Record<string, string>): void {
  rmSync(ssmDir, { recursive: true, force: true });
  mkdirSync(ssmDir);
  for (const [name, value] of Object.entries(values))
    writeFileSync(join(ssmDir, name.replaceAll("/", "_")), value);
}

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; out: string; calls: string[] } {
  const r = spawnSync("bash", [join(repo, "scripts/deploy-web.sh"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      HOME: dir,
      FAKE_LOG: log,
      FAKE_SSM_DIR: ssmDir,
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

const syncs = (calls: string[]) => calls.filter((c) => c.startsWith("aws s3 sync"));
const builds = (calls: string[]) => calls.filter((c) => c.startsWith("npm "));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-deploy-web-"));
  repo = join(dir, "repo");
  log = join(dir, "calls.log");
  ssmDir = join(dir, "ssm");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  copyFileSync(script, join(repo, "scripts/deploy-web.sh"));
  writeFileSync(join(repo, ".gitignore"), "apps/web/dist/\n");
  for (const [name, body] of [
    ["aws", FAKE_AWS],
    ["npm", FAKE_NPM],
  ] as const) {
    writeFileSync(join(dir, "bin", name), body);
    chmodSync(join(dir, "bin", name), 0o755);
  }
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  setSsm(SSM);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Each test spawns git and bash several times; on a busy machine that outruns the 5 s default.
describe("deploy-web.sh", { timeout: 30_000 }, () => {
  it("builds with the three Cognito IDs from SSM, syncs with cache headers in a safe order, and invalidates", () => {
    const { status, out, calls } = run(["dev"]);
    expect(status, out).toBe(0);

    expect(builds(calls)).toEqual([
      "npm run build -w apps/web VITE_USER_POOL_ID=us-east-1_TESTPOOL1 VITE_SPA_CLIENT_ID=testclient0000000000000000 VITE_IDENTITY_POOL_ID=us-east-1:00000000-0000-4000-8000-000000000000",
    ]);
    const bucket = "s3://sched-dev-web-000000000000";
    expect(syncs(calls)).toEqual([
      `aws s3 sync apps/web/dist ${bucket} --delete --dryrun`,
      `aws s3 sync apps/web/dist/assets ${bucket}/assets --cache-control public, max-age=31536000, immutable --only-show-errors`,
      `aws s3 sync apps/web/dist ${bucket} --exclude assets/* --delete --cache-control no-cache --metadata git-commit=${head()} --only-show-errors`,
      `aws s3 sync apps/web/dist/assets ${bucket}/assets --delete --cache-control public, max-age=31536000, immutable --only-show-errors`,
    ]);
    // The build runs before any sync, and the invalidation after the last one.
    expect(calls.findIndex((c) => c.startsWith("npm "))).toBeLessThan(
      calls.findIndex((c) => c.startsWith("aws s3")),
    );
    const invalidate = calls.findIndex((c) => c.startsWith("aws cloudfront create-invalidation"));
    expect(calls[invalidate]).toContain("--distribution-id ETESTDIST --paths /*");
    expect(invalidate).toBeGreaterThan(calls.findLastIndex((c) => c.startsWith("aws s3 sync")));
    expect(calls).toContain(
      "aws cloudfront wait invalidation-completed --distribution-id ETESTDIST --id ITESTINVALIDATION",
    );
    expect(out).toContain("https://dtest.cloudfront.example/ (invalidation ITESTINVALIDATION)");
  });

  it.each(["user-pool-id", "spa-client-id", "identity-pool-id"])(
    "fails before building when /sched/<env>/auth/%s is missing",
    (name) => {
      setSsm(without(`/sched/dev/auth/${name}`));
      const { status, out, calls } = run(["dev"]);
      expect(status).toBe(1);
      expect(out).toContain(`missing SSM parameters`);
      expect(out).toContain(`/sched/dev/auth/${name}`);
      expect(builds(calls)).toEqual([]);
      expect(syncs(calls)).toEqual([]);
    },
  );

  it("treats a parameter whose value is the CLI's None as missing", () => {
    setSsm({ ...SSM, "/sched/dev/auth/spa-client-id": "None" });
    const { status, out, calls } = run(["dev"]);
    expect(status).toBe(1);
    expect(out).toContain("/sched/dev/auth/spa-client-id");
    expect(builds(calls)).toEqual([]);
  });

  it.each(["bucket-name", "distribution-id", "domain"])(
    "fails before building when /sched/<env>/web/%s is missing",
    (name) => {
      setSsm(without(`/sched/dev/web/${name}`));
      const { status, out, calls } = run(["dev"]);
      expect(status).toBe(1);
      expect(out).toContain(`/sched/dev/web/${name}`);
      expect(builds(calls)).toEqual([]);
    },
  );

  it("reads the env's own parameters and refuses a bucket that isn't the env's site bucket", () => {
    setSsm(
      Object.fromEntries(Object.entries(SSM).map(([k, v]) => [k.replace("/sched/dev/", "/sched/pr7/"), v])),
    );
    const { status, out, calls } = run(["pr7"]);
    expect(status).toBe(1);
    expect(out).toContain("unexpected bucket 'sched-dev-web-000000000000' for env 'pr7'");
    expect(calls).toContain(
      "aws ssm get-parameter --name /sched/pr7/web/bucket-name --query Parameter.Value --output text",
    );
    expect(builds(calls)).toEqual([]);
  });

  it("refuses a dirty working tree, untracked files included, before calling AWS", () => {
    writeFileSync(join(repo, "stray.txt"), "x");
    const { status, out, calls } = run(["dev"]);
    expect(status).toBe(1);
    expect(out).toContain("uncommitted changes");
    expect(calls).toEqual([]);
  });

  it("refuses a modified tracked file", () => {
    writeFileSync(join(repo, ".gitignore"), "apps/web/dist/\nchanged\n");
    const { status, calls } = run(["dev"]);
    expect(status).toBe(1);
    expect(calls).toEqual([]);
  });

  it("stops when the credentials are missing or expired", () => {
    const { status, out, calls } = run(["dev"], { FAKE_STS_FAIL: "1" });
    expect(status).toBe(1);
    expect(out).toContain("aws sso login --profile sched-dev");
    expect(builds(calls)).toEqual([]);
  });

  it.each([
    ["none", "no apps/web/dist/index.html"],
    ["no-assets", "no files under apps/web/dist/assets/"],
    ["no-pool", "don't contain the 'dev' user pool ID"],
  ])("refuses to sync when the build output is incomplete (%s)", (build, message) => {
    const { status, out, calls } = run(["dev"], { FAKE_BUILD: build });
    expect(status).toBe(1);
    expect(out).toContain(message);
    expect(syncs(calls)).toEqual([]);
  });

  it("never publishes a stale build left in apps/web/dist", () => {
    mkdirSync(join(repo, "apps/web/dist/assets"), { recursive: true });
    writeFileSync(join(repo, "apps/web/dist/index.html"), "old");
    writeFileSync(join(repo, "apps/web/dist/assets/old.js"), SSM["/sched/dev/auth/user-pool-id"] ?? "");
    const { status, out, calls } = run(["dev"], { FAKE_BUILD: "none" });
    expect(status).toBe(1);
    expect(out).toContain("no apps/web/dist/index.html");
    expect(syncs(calls)).toEqual([]);
  });

  it("uses the sched-dev profile in us-east-1 by default, and the caller's when set", () => {
    expect(run(["dev", "--dry-run"]).calls).toContain("identity profile=sched-dev region=us-east-1");
    rmSync(log);
    const { calls } = run(["dev", "--dry-run"], { AWS_PROFILE: "other", AWS_REGION: "eu-west-1" });
    expect(calls).toContain("identity profile=other region=eu-west-1");
  });

  it("--dry-run prints the plan and changes nothing", () => {
    const { status, out, calls } = run(["dev", "--dry-run"]);
    expect(status, out).toBe(0);
    expect(syncs(calls)).toEqual([
      "aws s3 sync apps/web/dist s3://sched-dev-web-000000000000 --delete --dryrun",
    ]);
    expect(calls.filter((c) => c.startsWith("aws cloudfront"))).toEqual([]);
    expect(out).toContain("dry run: nothing uploaded");
  });

  it("warns when an unmerged branch publishes to a shared env, and not otherwise", () => {
    expect(run(["dev", "--dry-run"]).out).not.toContain("is shared");
    git("checkout", "-q", "-b", "feat/1-x");
    expect(run(["dev", "--dry-run"]).out).toContain("note: 'dev' is shared");
    setSsm(
      Object.fromEntries(
        Object.entries(SSM).map(([k, v]) => [k.replace("dev", "pr7"), v.replace("dev", "pr7")]),
      ),
    );
    expect(run(["pr7", "--dry-run"]).out).not.toContain("is shared");
  });

  it.each([[[]], [["Dev"]], [["dev", "--yes"]], [["dev", "--dry-run", "x"]]])(
    "rejects bad arguments %j",
    (args) => {
      const { status, calls } = run(args);
      expect(status).toBe(2);
      expect(calls).toEqual([]);
    },
  );
});
