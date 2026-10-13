/**
 * The GitHub OIDC roles' trust conditions and their protection in the bootstrap stack (#41, r1/Q-4 (a)), and the
 * deploy workflow's security-relevant settings (decision 9165bd3/TEST-3 (a) on PR #224).
 * `infra/` has no Vitest project, so this lives with the other repo-level tests. It reads
 * `infra/bootstrap/bootstrap.yaml` as text, so it checks the template as committed, before Nick applies it:
 *   - each role's trust has exactly one statement, which allows `sts:AssumeRoleWithWebIdentity` from GitHub's OIDC
 *     provider only when the token's `aud` is `sts.amazonaws.com` and its `sub` is exactly the one decided
 *     (r1/A-4, r1/A-5, r1/Q-2 (b)), in the repository's immutable subject form, with no other `sub` condition;
 *   - each role's sessions last at most an hour (r1/A-3);
 *   - each role, and the OIDC provider, is on `sched-cfn-exec`'s unconditional `ProtectBootstrapIdentities` deny,
 *     so no stack can rewrite a role's trust.
 * It also reads `.github/workflows/deploy.yml` as text: its only trigger is `workflow_dispatch`, it has one job, which
 * runs only on `refs/heads/main` in the `dev` environment (which the deploy role's `sub` names) with
 * `id-token: write`, its one credentials step (found as an item of `steps:` whatever its first key, `- uses:` or
 * `- name:`, and read inside that item) masks the account ID (r1/Q-3 (a)), and no line outside a comment names a script
 * under `scripts/` but the two calls with `dev`, which are two steps' `run:` values (one line or a `run: |` body).
 * Both files are read with the shared reader, scripts/test/yaml-text.ts (#157).
 * It doesn't check the grants (the PR lists them) or that AWS accepts the subject strings: the format was seen in a
 * probe run's tokens (journal, 2026-10-08), and the first run of each workflow shows the rest (runbook, "CI
 * credentials (GitHub OIDC)").
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { block, children, credentialsOf, entries, items } from "./test/yaml-text";

const lines = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "infra", "bootstrap", "bootstrap.yaml"),
  "utf8",
).split("\n");

const REPO = "repo:nick-delgado@25354284/serverless-ai-scheduling@1391507382";
const WORKFLOWS = "nick-delgado/serverless-ai-scheduling/.github/workflows";
const AUD = "token.actions.githubusercontent.com:aud";
const SUB = "token.actions.githubusercontent.com:sub";

/** sched-cfn-exec's deny on the bootstrap identities, looked up inside that role only (in a test, so a miss fails it). */
const protectDeny = (): string[] =>
  block(/^\s+- Sid: ProtectBootstrapIdentities$/, block(/^ {2}CfnExecutionRole:$/, lines));

const ROLES = [
  {
    logicalId: "GitHubDeployRole",
    roleName: "sched-github-deploy",
    operator: "StringEquals",
    sub: `${REPO}:environment:dev:job_workflow_ref:${WORKFLOWS}/deploy.yml@refs/heads/main`,
  },
  {
    logicalId: "GitHubEvalsRole",
    roleName: "sched-github-evals",
    operator: "StringLike",
    sub: `${REPO}:pull_request:job_workflow_ref:${WORKFLOWS}/evals.yml@refs/pull/*/merge`,
  },
  {
    logicalId: "GitHubE2eRole",
    roleName: "sched-github-e2e",
    operator: "StringLike",
    sub: `${REPO}:environment:e2e:job_workflow_ref:${WORKFLOWS}/e2e.yml@refs/heads/*`,
  },
] as const;

describe.each(ROLES)("$logicalId (bootstrap.yaml)", ({ logicalId, roleName, operator, sub }) => {
  const role = block(new RegExp(`^ {2}${logicalId}:$`), lines);
  const trust = block(/^\s+AssumeRolePolicyDocument:$/, role);
  const statements = items(block(/^\s+Statement:$/, trust));
  const condition = block(/^\s+Condition:$/, trust);

  it(`is named ${roleName}, with sessions of at most an hour`, () => {
    expect(entries(block(/^\s+Properties:$/, role))).toMatchObject({
      RoleName: roleName,
      MaxSessionDuration: "3600",
    });
  });

  it("has one trust statement, which allows only a token from GitHub's OIDC provider", () => {
    expect(statements).toHaveLength(1);
    expect(trust.filter((l) => /^\s+(- )?Effect:/.test(l))).toEqual([
      expect.stringMatching(/Effect: Allow$/),
    ]);
    expect(entries(block(/^\s+Principal:$/, trust))).toEqual({ Federated: "!Ref GitHubOidcProvider" });
    expect(trust.some((l) => /^\s+Action: sts:AssumeRoleWithWebIdentity$/.test(l))).toBe(true);
  });

  it("accepts only the audience sts.amazonaws.com", () => {
    expect(entries(block(/^\s+StringEquals:$/, condition))[AUD]).toBe("sts.amazonaws.com");
  });

  it(`accepts only the decided subject, with ${operator}`, () => {
    expect(entries(block(new RegExp(`^\\s+${operator}:$`), condition))[SUB]).toBe(sub);
    expect(condition.filter((l) => l.includes(SUB))).toHaveLength(1);
  });

  it("is on sched-cfn-exec's unconditional ProtectBootstrapIdentities deny", () => {
    const deny = protectDeny();
    expect(deny).toContain("                Effect: Deny");
    expect(deny).toContain("                Action: iam:*");
    expect(deny.some((l) => /^\s+Condition:/.test(l))).toBe(false);
    expect(block(/^\s+Resource:$/, deny)).toContain(
      `                  - !Sub arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/${roleName}`,
    );
  });
});

describe("GitHubOidcProvider (bootstrap.yaml)", () => {
  it("is GitHub's token issuer for the STS audience", () => {
    const provider = block(/^ {2}GitHubOidcProvider:$/, lines);
    expect(entries(block(/^\s+Properties:$/, provider))).toMatchObject({
      Url: "https://token.actions.githubusercontent.com",
    });
    expect(
      block(/^\s+ClientIdList:$/, provider)
        .slice(1)
        .filter((l) => l.trim() !== ""),
    ).toEqual(["        - sts.amazonaws.com"]);
  });

  it("is on sched-cfn-exec's ProtectBootstrapIdentities deny", () => {
    expect(block(/^\s+Resource:$/, protectDeny())).toContain("                  - !Ref GitHubOidcProvider");
  });
});

describe("deploy workflow (.github/workflows/deploy.yml)", () => {
  const workflow = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "deploy.yml"),
    "utf8",
  ).split("\n");
  const job = block(/^ {2}deploy:$/, workflow);
  const steps = items(block(/^\s+steps:$/, job));

  it("runs only by hand (workflow_dispatch)", () => {
    expect(children(block(/^on:$/, workflow))).toEqual(["  workflow_dispatch:"]);
  });

  it("has one job, so the checks below cover the whole file", () => {
    expect(children(block(/^jobs:$/, workflow))).toEqual(["  deploy:"]);
  });

  it("runs only from main, in the dev environment the deploy role's subject names", () => {
    expect(entries(job)).toMatchObject({ if: "github.ref == 'refs/heads/main'", environment: "dev" });
    expect(ROLES.find((r) => r.logicalId === "GitHubDeployRole")?.sub).toContain(":environment:dev:");
  });

  it("asks for an OIDC token and only read access to the code", () => {
    expect(entries(block(/^\s+permissions:$/, job))).toEqual({ contents: "read", "id-token": "write" });
  });

  it("has one credentials step, which takes the deploy role and masks the account ID", () => {
    // The step is found as an item in any form (`- uses:` or `uses:` under a `- name:`), and its `with:` read inside it.
    const credentials = credentialsOf(job);
    expect([credentials.lines, credentials.steps.length]).toEqual([1, 1]);
    expect(credentials.settings).toMatchObject({
      "role-to-assume": "${{ secrets.AWS_DEPLOY_ROLE_ARN }}",
      "mask-aws-account-id": "true",
    });
  });

  it("deploys dev with the two scripts and runs no other script", () => {
    // Every non-comment line naming scripts/, so a call inside a `run: |` block counts too.
    const scripts = job.filter((l) => !l.trimStart().startsWith("#") && l.includes("scripts/"));
    expect(scripts.map((l) => l.trim().replace(/^(- )?run: /, ""))).toEqual([
      "scripts/deploy.sh all dev",
      "scripts/deploy-web.sh dev",
    ]);
    // And they are steps' `run:` values, read inside each step (a one-line `run:` or a `run: |` body).
    const runs = steps.flatMap((step) => (entries(step).run ?? "").split("\n"));
    expect(runs.filter((l) => !l.trimStart().startsWith("#") && l.includes("scripts/"))).toEqual([
      "scripts/deploy.sh all dev",
      "scripts/deploy-web.sh dev",
    ]);
  });
});
