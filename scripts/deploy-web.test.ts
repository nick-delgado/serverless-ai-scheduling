/**
 * scripts/deploy-web.sh (#100), run for real through the shell harness (scripts/test/shell-harness.ts, #137): each test
 * copies the script into a throwaway git repo, so its repo_root, working-tree check and build output are that repo's,
 * and runs it against stand-in `aws` and `npm` commands that log every call. `aws ssm get-parameter` answers from a
 * per-test map, and the `npm` stand-in below writes a fake build that embeds the user pool and Identity Pool IDs it
 * was given.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BAD_ENV_NAMES, GOOD_ENV_NAMES, sandbox, type Sandbox, webSsm } from "./test/shell-harness";

const SSM = webSsm("dev");
const POOL = SSM["/sched/dev/auth/user-pool-id"] ?? "";

// Writes apps/web/dist like Vite does, unless FAKE_BUILD says otherwise.
const FAKE_NPM = `#!/usr/bin/env bash
echo "npm $* VITE_USER_POOL_ID=\${VITE_USER_POOL_ID-unset} VITE_SPA_CLIENT_ID=\${VITE_SPA_CLIENT_ID-unset} VITE_IDENTITY_POOL_ID=\${VITE_IDENTITY_POOL_ID-unset} VITE_REQUEST_ACCESS=\${VITE_REQUEST_ACCESS-unset} VITE_TURNSTILE_SITE_KEY=\${VITE_TURNSTILE_SITE_KEY-unset}" >> "$FAKE_LOG"
[[ "\${FAKE_BUILD:-}" == "none" ]] && exit 0
mkdir -p apps/web/dist/assets
[[ "\${FAKE_BUILD:-}" == "no-index" ]] || echo '<!doctype html><script src="/assets/index-abc123.js"></script>' > apps/web/dist/index.html
[[ "\${FAKE_BUILD:-}" == "no-assets" ]] && exit 0
pool="$VITE_USER_POOL_ID"
[[ "\${FAKE_BUILD:-}" == "no-pool" ]] && pool=""
identity_pool="$VITE_IDENTITY_POOL_ID"
[[ "\${FAKE_BUILD:-}" == "no-identity-pool" ]] && identity_pool=""
site_key="$VITE_TURNSTILE_SITE_KEY"
[[ "\${FAKE_BUILD:-}" == "no-site-key" ]] && site_key=""
echo "const c={userPoolId:\\"$pool\\",identityPoolId:\\"$identity_pool\\",turnstileSiteKey:\\"$site_key\\"}" > apps/web/dist/assets/index-abc123.js
`;

let sb: Sandbox;

const git = (...args: string[]) => sb.repo.git(...args);
const head = () => git("rev-parse", "--short=12", "HEAD").trim();
const run = (args: string[], env: Record<string, string> = {}) =>
  sb.run("scripts/deploy-web.sh", args, { env });
const setSsm = (values: Record<string, string>) => sb.setSsm(values);

function without(name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(SSM).filter(([key]) => key !== name));
}

// The SSM map with its names moved to another env; renameValues moves the values too.
function ssmFor(env: string, renameValues: boolean): Record<string, string> {
  return Object.fromEntries(
    Object.entries(SSM).map(([k, v]) => [
      k.replace("/sched/dev/", `/sched/${env}/`),
      renameValues ? v.replace("sched-dev-", `sched-${env}-`) : v,
    ]),
  );
}

const syncs = (calls: string[]) => calls.filter((c) => c.startsWith("aws s3 sync"));
const builds = (calls: string[]) => calls.filter((c) => c.startsWith("npm "));

beforeEach(() => {
  sb = sandbox({
    prefix: "sched-deploy-web-",
    files: ["scripts/deploy-web.sh"],
    write: { ".gitignore": "apps/web/dist/\n.env\n" },
    standIns: { npm: FAKE_NPM },
  });
  setSsm(SSM);
});

afterEach(() => {
  sb.remove();
});

// Each test spawns git and bash several times; on a busy machine that outruns the 5 s default.
describe("deploy-web.sh", { timeout: 30_000 }, () => {
  it("builds with the three Cognito IDs from SSM, syncs with cache headers in a safe order, and invalidates", () => {
    const { status, out, calls } = run(["dev"]);
    expect(status, out).toBe(0);

    expect(builds(calls)).toEqual([
      `npm run build -w apps/web VITE_USER_POOL_ID=${POOL} VITE_SPA_CLIENT_ID=${SSM["/sched/dev/auth/spa-client-id"] ?? ""} VITE_IDENTITY_POOL_ID=${SSM["/sched/dev/auth/identity-pool-id"] ?? ""} VITE_REQUEST_ACCESS=off VITE_TURNSTILE_SITE_KEY=`,
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
    expect(calls[invalidate]).toBe(
      "aws cloudfront create-invalidation --distribution-id ETESTDIST --paths /* --query Invalidation.Id --output text",
    );
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
    setSsm(ssmFor("pr7", false));
    const { status, out, calls } = run(["pr7"]);
    expect(status).toBe(1);
    expect(out).toContain("unexpected bucket 'sched-dev-web-000000000000' for env 'pr7'");
    expect(calls).toContain(
      "aws ssm get-parameter --name /sched/pr7/web/bucket-name --query Parameter.Value --output text",
    );
    expect(builds(calls)).toEqual([]);
  });

  it("shows the CLI's own error when an SSM read fails for a reason other than not-found", () => {
    const { status, out, calls } = run(["dev"], {
      FAKE_SSM_ERROR:
        "An error occurred (ThrottlingException) when calling the GetParameter operation: Rate exceeded",
    });
    expect(status).toBe(1);
    expect(out).toContain("(ThrottlingException)");
    expect(builds(calls)).toEqual([]);
  });

  it("refuses a dirty working tree, untracked files included, before calling AWS", () => {
    writeFileSync(join(sb.repo.dir, "stray.txt"), "x");
    const { status, out, calls } = run(["dev"]);
    expect(status).toBe(1);
    expect(out).toContain("uncommitted changes");
    expect(calls).toEqual([]);
  });

  it("refuses a modified tracked file", () => {
    writeFileSync(join(sb.repo.dir, ".gitignore"), "apps/web/dist/\nchanged\n");
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
    ["no-index", "no apps/web/dist/index.html"],
    ["no-assets", "no files under apps/web/dist/assets/"],
    ["no-pool", "don't contain the 'dev' user pool ID"],
    [
      "no-identity-pool",
      "don't contain the 'dev' Identity Pool ID; VITE_IDENTITY_POOL_ID didn't reach the build",
    ],
  ])("refuses to sync when the build output is incomplete (%s)", (build, message) => {
    const { status, out, calls } = run(["dev"], { FAKE_BUILD: build });
    expect(status).toBe(1);
    expect(out).toContain(message);
    expect(syncs(calls)).toEqual([]);
  });

  it("never publishes a stale build left in apps/web/dist", () => {
    mkdirSync(join(sb.repo.dir, "apps/web/dist/assets"), { recursive: true });
    writeFileSync(join(sb.repo.dir, "apps/web/dist/index.html"), "old");
    writeFileSync(join(sb.repo.dir, "apps/web/dist/assets/old.js"), POOL);
    const { status, out, calls } = run(["dev"], { FAKE_BUILD: "none" });
    expect(status).toBe(1);
    expect(out).toContain("no apps/web/dist/index.html");
    expect(syncs(calls)).toEqual([]);
  });

  it("uses the sched-dev profile in us-east-1 by default, and the caller's when set", () => {
    expect(run(["dev", "--dry-run"]).calls).toContain("identity profile=sched-dev region=us-east-1");
    sb.clearCalls();
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
    setSsm(ssmFor("demo", true));
    expect(run(["demo", "--dry-run"]).out).toContain("note: 'demo' is shared");
    setSsm(ssmFor("pr7", true));
    expect(run(["pr7", "--dry-run"]).out).not.toContain("is shared");
  });

  it.each([[[]], ...BAD_ENV_NAMES.map((name) => [[name]]), [["dev", "--yes"]], [["dev", "--dry-run", "x"]]])(
    "rejects bad arguments %j",
    (args) => {
      const { status, calls } = run(args);
      expect(status).toBe(2);
      expect(calls).toEqual([]);
    },
  );

  it.each(GOOD_ENV_NAMES)("accepts the env name %s (2 and 16 characters are the length bounds)", (env) => {
    const { status, out } = run([env, "--dry-run"]);
    expect(status).toBe(1);
    expect(out).toContain(`missing SSM parameters (deploy the auth and web stacks for '${env}' first)`);
  });
  describe("the reviewer access page (#357)", () => {
    // Cloudflare's documented always-passes test site key; public, and it names no real widget.
    const SITE_KEY = "1x00000000000000000000AA";
    const DOTENV_KEY = "dotenv-site-key-0000000000";
    const REQUEST = "/sched/dev/api/request-access";
    const lastBuild = (calls: string[]) => builds(calls).at(-1) ?? "";

    it("builds with the page off when the parameter is missing, and ignores a site key it was given", () => {
      const r = run(["dev"], { TURNSTILE_SITE_KEY: SITE_KEY });
      expect(r.status, r.out).toBe(0);
      expect(lastBuild(r.calls)).toContain("VITE_REQUEST_ACCESS=off VITE_TURNSTILE_SITE_KEY=");
      expect(lastBuild(r.calls)).not.toContain(SITE_KEY);
    });

    it("builds with the page off when the parameter says off", () => {
      setSsm({ ...SSM, [REQUEST]: "off" });
      const r = run(["dev"], { TURNSTILE_SITE_KEY: SITE_KEY });
      expect(r.status, r.out).toBe(0);
      expect(lastBuild(r.calls)).toContain("VITE_REQUEST_ACCESS=off VITE_TURNSTILE_SITE_KEY=");
    });

    it("reads anything but exactly 'on' as off", () => {
      setSsm({ ...SSM, [REQUEST]: "ON " });
      const r = run(["dev"], { TURNSTILE_SITE_KEY: SITE_KEY });
      expect(r.status, r.out).toBe(0);
      expect(lastBuild(r.calls)).toContain("VITE_REQUEST_ACCESS=off");
    });

    it("builds with the page on and the site key from the environment when the parameter says on", () => {
      setSsm({ ...SSM, [REQUEST]: "on" });
      const r = run(["dev"], { TURNSTILE_SITE_KEY: SITE_KEY });
      expect(r.status, r.out).toBe(0);
      expect(lastBuild(r.calls)).toContain(`VITE_REQUEST_ACCESS=on VITE_TURNSTILE_SITE_KEY=${SITE_KEY}`);
    });

    it("reads the site key from .env when the environment has none, and prefers the environment", () => {
      setSsm({ ...SSM, [REQUEST]: "on" });
      writeFileSync(join(sb.repo.dir, ".env"), `TURNSTILE_SITE_KEY=${DOTENV_KEY}\n`);
      expect(lastBuild(run(["dev"]).calls)).toContain(`VITE_TURNSTILE_SITE_KEY=${DOTENV_KEY}`);
      sb.clearCalls();
      expect(lastBuild(run(["dev"], { TURNSTILE_SITE_KEY: SITE_KEY }).calls)).toContain(
        `VITE_TURNSTILE_SITE_KEY=${SITE_KEY}`,
      );
    });

    it("refuses to build with the page on and no site key, before the build and any sync", () => {
      setSsm({ ...SSM, [REQUEST]: "on" });
      const r = run(["dev"]);
      expect(r.status).toBe(1);
      expect(r.out).toContain("TURNSTILE_SITE_KEY must be set");
      expect(builds(r.calls)).toEqual([]);
      expect(syncs(r.calls)).toEqual([]);
    });

    it("refuses a site key that spans lines", () => {
      setSsm({ ...SSM, [REQUEST]: "on" });
      const r = run(["dev"], { TURNSTILE_SITE_KEY: `${SITE_KEY}\nx` });
      expect(r.status).toBe(1);
      expect(r.out).toContain("TURNSTILE_SITE_KEY must be set");
      expect(builds(r.calls)).toEqual([]);
    });

    it("refuses to publish a build whose bundle lacks the site key", () => {
      setSsm({ ...SSM, [REQUEST]: "on" });
      const r = run(["dev"], { TURNSTILE_SITE_KEY: SITE_KEY, FAKE_BUILD: "no-site-key" });
      expect(r.status).toBe(1);
      expect(r.out).toContain("Turnstile site key");
      expect(syncs(r.calls)).toEqual([]);
    });

    it("builds with the page off when the parameter can't be read", () => {
      setSsm({ ...SSM, [REQUEST]: "on" });
      const r = run(["dev"], {
        FAKE_SSM_ERROR: "boom",
        FAKE_SSM_ERROR_NAME: REQUEST,
        TURNSTILE_SITE_KEY: SITE_KEY,
      });
      expect(r.status, r.out).toBe(0);
      expect(lastBuild(r.calls)).toContain("VITE_REQUEST_ACCESS=off");
    });
  });
});
