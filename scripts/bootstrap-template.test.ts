/**
 * The GitHub OIDC roles' trust conditions and their protection in the bootstrap stack (#41, r1/Q-4 (a)).
 * `infra/` has no Vitest project, so this lives with the other repo-level tests. It reads
 * `infra/bootstrap/bootstrap.yaml` as text, so it checks the template as committed, before Nick applies it:
 *   - each role is assumable only with a GitHub OIDC token (`sts:AssumeRoleWithWebIdentity` from the provider),
 *     whose `aud` is `sts.amazonaws.com` and whose `sub` is exactly the one decided (r1/A-4, r1/A-5, r1/Q-2 (b)),
 *     in the repository's immutable subject form, with no other `sub` condition beside it;
 *   - each role's sessions last at most an hour (r1/A-3);
 *   - each role, and the OIDC provider, is on `sched-cfn-exec`'s `ProtectBootstrapIdentities` deny, so no stack
 *     can rewrite a role's trust.
 * It doesn't check the grants (the PR lists them) or that AWS and GitHub agree on the subject strings: the
 * first run of each workflow shows that (runbook, "CI credentials (GitHub OIDC)").
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const template = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "infra", "bootstrap", "bootstrap.yaml"),
  "utf8",
);
const lines = template.split("\n");

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The lines of the block that starts at the first line of `within` matching `header`: that line and every
 * following line that is blank or indented deeper than it. A file-local copy of the slicer in
 * scripts/web-template.test.ts, until #157's shared helper lands.
 */
function block(header: RegExp, within: string[] = lines): string[] {
  const start = within.findIndex((line) => header.test(line));
  if (start === -1) throw new Error(`bootstrap.yaml: no line matches ${String(header)}`);
  const indent = indentOf(within[start] ?? "");
  const end = within.findIndex((line, i) => i > start && line.trim() !== "" && indentOf(line) <= indent);
  return within.slice(start, end === -1 ? undefined : end);
}

/** The `key: value` entries directly under a block's header line, values unquoted. */
function entries(lines: string[]): Record<string, string> {
  const [header, ...body] = lines;
  const childIndent = indentOf(body.find((l) => l.trim() !== "") ?? "");
  const out: Record<string, string> = {};
  for (const line of body) {
    if (indentOf(line) !== childIndent || indentOf(line) <= indentOf(header ?? "")) continue;
    const match = /^\s*([^:\s][^\s]*?):\s+(.+)$/.exec(line);
    if (match?.[1] && match[2]) out[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const REPO = "repo:nick-delgado@25354284/serverless-ai-scheduling@1391507382";
const WORKFLOWS = "nick-delgado/serverless-ai-scheduling/.github/workflows";
const AUD = "token.actions.githubusercontent.com:aud";
const SUB = "token.actions.githubusercontent.com:sub";

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
  const role = block(new RegExp(`^ {2}${logicalId}:$`));
  const trust = block(/^\s+AssumeRolePolicyDocument:$/, role);
  const condition = block(/^\s+Condition:$/, trust);

  it(`is named ${roleName}, with sessions of at most an hour`, () => {
    expect(entries(block(/^\s+Properties:$/, role))).toMatchObject({
      RoleName: roleName,
      MaxSessionDuration: "3600",
    });
  });

  it("is assumable only with a token from GitHub's OIDC provider", () => {
    expect(trust.filter((l) => /^\s+- Effect:/.test(l))).toEqual([expect.stringMatching(/- Effect: Allow$/)]);
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

  it("is on sched-cfn-exec's ProtectBootstrapIdentities deny", () => {
    const deny = block(/^\s+- Sid: ProtectBootstrapIdentities$/);
    expect(deny).toContain("                Effect: Deny");
    expect(deny).toContain("                Action: iam:*");
    expect(block(/^\s+Resource:$/, deny)).toContain(
      `                  - !Sub arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/${roleName}`,
    );
  });
});

describe("GitHubOidcProvider (bootstrap.yaml)", () => {
  it("is GitHub's token issuer for the STS audience", () => {
    const provider = block(/^ {2}GitHubOidcProvider:$/);
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
    expect(block(/^\s+Resource:$/, block(/^\s+- Sid: ProtectBootstrapIdentities$/))).toContain(
      "                  - !Ref GitHubOidcProvider",
    );
  });
});
