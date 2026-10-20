/**
 * The bootstrap stack's and the `SchedDeployer` policy's grants, and the GitHub OIDC roles' trust conditions and their
 * protection (#41, r1/Q-4 (a)), and the deploy workflow's security-relevant settings (decision 9165bd3/TEST-3 (a) on
 * PR #224).
 * `infra/` has no Vitest project, so this lives with the other repo-level tests. It reads
 * `infra/bootstrap/bootstrap.yaml` as text and `infra/bootstrap/sched-deployer-policy.json` as JSON, so it checks both
 * as committed, before Nick applies them:
 *   - each role's trust has exactly one statement, which allows `sts:AssumeRoleWithWebIdentity` from GitHub's OIDC
 *     provider only when the token's `aud` is `sts.amazonaws.com` and its `sub` is exactly the one decided
 *     (r1/A-4, r1/A-5, r1/Q-2 (b)), in the repository's immutable subject form, with no other `sub` condition;
 *   - each role's sessions last at most an hour (r1/A-3);
 *   - each role, and the OIDC provider, is on `sched-cfn-exec`'s unconditional `ProtectBootstrapIdentities` deny,
 *     so no stack can rewrite a role's trust;
 *   - the grants #270 narrowed (security review F-4 to F-9, F-13, F-22 to F-24; r1/Q-7 (a)): for each statement it
 *     changed, the `Action` and `Resource` lists equal fixed lists, so an added or removed entry fails the test named
 *     for its finding;
 *   - the exec role's service grants (#270's second PR, F-3; r1/Q-2 (a), r1/Q-7 (a)): one statement per service,
 *     its `service:*` action and its resources fixed, no Events, X-Ray, SES or Bedrock grant, and a comment directly
 *     above each statement that keeps `"*"`.
 * It also reads `.github/workflows/deploy.yml` as text: its only trigger is `workflow_dispatch`, it has one job, which
 * runs only on `refs/heads/main` in the `dev` environment (which the deploy role's `sub` names) with
 * `id-token: write`, its one credentials step (found as an item of `steps:` whatever its first key, `- uses:` or
 * `- name:`, and read inside that item) masks the account ID (r1/Q-3 (a)), and no line outside a comment names a script
 * under `scripts/` but the two calls with `dev`, which are two steps' `run:` values (one line or a `run: |` body).
 * It reads `.github/workflows/e2e.yml` the same way (#40, decision 607c339/TEST-201 (a) on PR #262): its trigger, its
 * concurrency group, its one job and environment, its credentials step, the order of its deploy, reseed and test
 * steps, the deploy's turn cap and SES secrets, which steps get the config-only profile or an empty `AWS_PROFILE`, and
 * the patient's password: from which secret the env-file step writes `$RUNNER_TEMP/e2e.env` (owner-only), which the
 * Cognito reseed reads, and which the suite's step gets.
 * The files are read with the shared reader, scripts/test/yaml-text.ts (#157).
 * It doesn't check that AWS accepts the subject strings: the format was seen in a probe run's tokens (journal,
 * 2026-10-08), and the first run of each workflow shows the rest (runbook, "CI credentials (GitHub OIDC)"). Whether a
 * narrowed grant is still enough is shown by the deploys after Nick's apply, not here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MODEL_PROFILES } from "@sched/agent";
import { createTableInput } from "@sched/tools/dynamo";
import { describe, expect, it } from "vitest";

import { block, children, credentialsOf, entries, items, member, stepsOf } from "./test/yaml-text";

const lines = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "infra", "bootstrap", "bootstrap.yaml"),
  "utf8",
).split("\n");

const policy = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "infra", "bootstrap", "sched-deployer-policy.json"),
    "utf8",
  ),
) as { Statement: { Sid: string; Action: string | string[]; Resource: string | string[] }[] };

/** A statement's `Action` and `Resource` as lists, whatever form each takes in the policy. */
interface Grant {
  Action: string[];
  Resource: string[];
}

/** The `SchedDeployer` policy's statement `sid`; throws (failing the calling test) when there isn't exactly one. */
const deployerGrant = (sid: string): Grant => {
  const found = policy.Statement.filter((st) => st.Sid === sid);
  if (found.length !== 1) throw new Error(`${String(found.length)} statements with Sid ${sid}`);
  const [only] = found;
  return { Action: [only?.Action].flat() as string[], Resource: [only?.Resource].flat() as string[] };
};

/** A statement of a bootstrap.yaml resource, by its Sid, read with the shared reader. */
const yamlStatement = (logicalId: string, sid: string): string[] =>
  block(new RegExp(`^\\s+- Sid: ${sid}$`), block(new RegExp(`^ {2}${logicalId}:$`), lines));

/** A statement's `Action` or `Resource`: a one-line value as a one-item list, or a list's items as their values. */
const valuesOf = (statement: string[], key: "Action" | "Resource"): string[] => {
  const one = entries(statement)[key];
  if (one !== undefined) return [one];
  return items(block(new RegExp(`^\\s+${key}:$`), statement)).map((item) =>
    (item[0] ?? "").trim().replace(/^- /, ""),
  );
};

/** A bootstrap.yaml statement's `Action` and `Resource`, as `deployerGrant` returns a JSON one's. */
const yamlGrant = (logicalId: string, sid: string): Grant => {
  const statement = yamlStatement(logicalId, sid);
  return { Action: valuesOf(statement, "Action"), Resource: valuesOf(statement, "Resource") };
};

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
  const steps = stepsOf(job);

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

describe("the E2E workflow (.github/workflows/e2e.yml; 607c339/TEST-201 (a) on PR #262)", () => {
  const workflow = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "e2e.yml"),
    "utf8",
  ).split("\n");
  const job = block(/^ {2}e2e:$/, workflow);
  const steps = stepsOf(job);
  /** The step named `name`; throws (failing the calling test) when there isn't exactly one. */
  const step = (name: string): string[] => {
    const found = steps.filter((s) => entries(s).name === name);
    if (found.length !== 1) throw new Error(`${String(found.length)} steps named "${name}"`);
    return found[0] as string[];
  };
  const env = (name: string) => member(step(name), "env");

  it("runs only by hand (workflow_dispatch): never on pull requests or pushes (#40 non-goals)", () => {
    expect(children(block(/^on:$/, workflow))).toEqual(["  workflow_dispatch:"]);
  });

  it("queues runs in one concurrency group and never cancels one mid-run (r1/A-9)", () => {
    expect(entries(block(/^concurrency:$/, workflow))).toEqual({
      group: "e2e",
      "cancel-in-progress": "false",
    });
  });

  it("has one job, in the e2e environment, with an OIDC token and read access to the code (r1/A-10)", () => {
    expect(children(block(/^jobs:$/, workflow))).toEqual(["  e2e:"]);
    expect(entries(job)).toMatchObject({ environment: "e2e" });
    expect(entries(block(/^\s+permissions:$/, job))).toEqual({ contents: "read", "id-token": "write" });
  });

  it("takes the E2E role from its environment secret and masks the account ID (AC8)", () => {
    const credentials = credentialsOf(job);
    expect([credentials.lines, credentials.steps.length]).toEqual([1, 1]);
    expect(credentials.settings).toMatchObject({
      "role-to-assume": "${{ secrets.AWS_E2E_ROLE_ARN }}",
      "mask-aws-account-id": "true",
    });
  });

  it("deploys, publishes, reseeds once and then runs the suite, in that order (r1/Q-4 (a), AC2)", () => {
    const names = steps.map((s) => entries(s).name).filter((n) => n !== undefined);
    const order = [
      "Deploy the stacks",
      "Publish the SPA",
      "Write the E2E patient's env file",
      "Reseed the E2E patient's Cognito user",
      "Reseed the e2e table",
      "Run the journeys",
    ];
    expect(names.filter((n) => order.includes(n))).toEqual(order);
  });

  it("deploys e2e with the turn cap and the escalation email's SES secrets (r1/A-7, r1/Q-5 (b))", () => {
    expect(entries(step("Deploy the stacks")).run).toBe(
      "scripts/deploy.sh all e2e -- DailyTurnCap=500 EnvDailyTurnCap=1000",
    );
    expect(env("Deploy the stacks")).toMatchObject({
      SES_SENDER: "${{ secrets.SES_SENDER }}",
      SES_STAFF_RECIPIENT: "${{ secrets.SES_STAFF_RECIPIENT }}",
    });
    expect(entries(step("Publish the SPA")).run).toBe("scripts/deploy-web.sh e2e");
  });

  it("gives the config-only profile to the CLI steps and an empty AWS_PROFILE to the SDK steps (r1/A-1)", () => {
    for (const name of ["Deploy the stacks", "Publish the SPA"]) {
      expect(env(name), name).toMatchObject({ AWS_PROFILE: "github-oidc" });
    }
    for (const name of [
      "Reseed the E2E patient's Cognito user",
      "Reseed the e2e table",
      "Run the journeys",
    ]) {
      // The shared reader reads an empty value as a nested block, so the line itself is checked, in the step's env.
      expect(
        block(/^\s+env:$/, step(name)).map((l) => l.trim()),
        name,
      ).toContain('AWS_PROFILE: ""');
    }
    expect(workflow.filter((l) => !l.trimStart().startsWith("#") && l.includes("GITHUB_ENV"))).toEqual([]);
  });

  it("writes the E2E patient's env file from its environment secret, outside the checkout, owner-only (r1/A-1)", () => {
    const write = step("Write the E2E patient's env file");
    expect(member(write, "env")).toEqual({ DEMO_PASSWORD_SOFIA: "${{ secrets.DEMO_PASSWORD_SOFIA }}" });
    expect((entries(write).run ?? "").split("\n")).toEqual([
      "umask 077",
      `printf 'DEMO_PASSWORD_SOFIA=%s\\n' "$DEMO_PASSWORD_SOFIA" > "$RUNNER_TEMP/e2e.env"`,
      "",
    ]);
  });

  it("reseeds the E2E patient from the env file, then resets the table with its name (AC2)", () => {
    expect(entries(step("Reseed the E2E patient's Cognito user")).run).toBe(
      'npx tsx scripts/seed-users.ts --env e2e --env-file "$RUNNER_TEMP/e2e.env"',
    );
    expect(entries(step("Reseed the e2e table")).run).toContain(
      'npx tsx scripts/seed-data.ts --env e2e --reset --confirm "$table"',
    );
  });

  it("runs the suite with the E2E patient's password from its environment secret (AC8)", () => {
    expect(entries(step("Run the journeys")).run).toBe("npm run e2e -w apps/web");
    expect(env("Run the journeys")).toMatchObject({
      DEMO_PASSWORD_SOFIA: "${{ secrets.DEMO_PASSWORD_SOFIA }}",
    });
  });
});

/** The Bedrock ARNs a deployed principal needs for the entitled profiles `keys` (or all of them), in profile order. */
const bedrockArns = (keys: string[] | undefined, partition: string, region: string, account: string) => {
  const chosen = Object.values(MODEL_PROFILES).filter((p) => p.entitled && (keys?.includes(p.name) ?? true));
  const us = chosen.filter((p) => p.modelId.startsWith("us."));
  const direct = chosen.filter((p) => !p.modelId.startsWith("us."));
  return [
    ...us.map((p) => `arn:${partition}:bedrock:${region}:${account}:inference-profile/${p.modelId}`),
    ...us.map((p) => `arn:${partition}:bedrock:*::foundation-model/${p.modelId.slice("us.".length)}`),
    ...direct.map((p) => `arn:${partition}:bedrock:${region}::foundation-model/${p.modelId}`),
  ];
};

/** The one index of the table, from the CreateTable input that `packages/tools` keeps in step with data.yaml. */
const INDEX = (createTableInput("t").GlobalSecondaryIndexes ?? []).map((i) => String(i.IndexName));

describe("the permissions boundary's WorkloadServices (#270; F-4, F-23)", () => {
  it("allows exactly the 14 actions a sched-* workload role grants, on all resources (F-23)", () => {
    const grant = yamlGrant("WorkloadPermissionsBoundary", "WorkloadServices");
    expect(grant).toEqual({
      Action: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:ConditionCheckItem",
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "ses:SendEmail",
        "transcribe:StartStreamTranscriptionWebSocket",
      ],
      Resource: ["*"],
    });
    expect(entries(yamlStatement("WorkloadPermissionsBoundary", "WorkloadServices")).Effect).toBe("Allow");
    expect(grant.Action).not.toContain("ssm:GetParameter");
  });

  it("holds no Bedrock Mantle action, which nothing calls since ADR-010 (F-4)", () => {
    const { Action } = yamlGrant("WorkloadPermissionsBoundary", "WorkloadServices");
    expect(Action.filter((a) => a.startsWith("bedrock-mantle:"))).toEqual([]);
  });
});

describe("the CI roles' narrowed grants (#270; F-5, F-13, F-22, F-24)", () => {
  it("names the sonnet foundation model without a trailing wildcard in the evals role, for the eval profiles only (F-5)", () => {
    expect(yamlGrant("GitHubEvalsRole", "InvokeEvalModels")).toEqual({
      Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      Resource: bedrockArns(
        ["sonnet-4.6", "haiku-4.5"],
        "${AWS::Partition}",
        "${AWS::Region}",
        "${AWS::AccountId}",
      ).map((arn) => `!Sub ${arn}`),
    });
  });

  it("names only table/sched-e2e-*/index/GSI1, the table's one index, in the e2e seeding grant (F-13)", () => {
    expect(INDEX).toEqual(["GSI1"]);
    expect(yamlGrant("GitHubE2eRole", "SeedE2eData")).toEqual({
      Action: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem",
        "dynamodb:BatchGetItem",
      ],
      Resource: [
        "!Sub arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/sched-e2e-*",
        ...INDEX.map(
          (name) =>
            `!Sub arn:\${AWS::Partition}:dynamodb:\${AWS::Region}:\${AWS::AccountId}:table/sched-e2e-*/index/${name}`,
        ),
      ],
    });
  });

  it.each([
    { role: "GitHubDeployRole", sid: "ArtifactAndDevSiteBuckets", env: "dev" },
    { role: "GitHubE2eRole", sid: "ArtifactAndE2eSiteBuckets", env: "e2e" },
  ])("limits $role's artifact bucket objects to its own env's prefix (F-24)", ({ role, sid, env }) => {
    expect(yamlGrant(role, sid)).toEqual({
      Action: ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: [
        "!GetAtt ArtifactBucket.Arn",
        `!Sub \${ArtifactBucket.Arn}/sched-${env}-*`,
        `!Sub arn:\${AWS::Partition}:s3:::sched-${env}-web-*`,
        `!Sub arn:\${AWS::Partition}:s3:::sched-${env}-web-*/*`,
      ],
    });
  });

  it.each([
    { role: "GitHubDeployRole", drive: "CloudFormationDriveDevStacks", env: "dev" },
    { role: "GitHubE2eRole", drive: "CloudFormationDriveE2eStacks", env: "e2e" },
  ])('grants $role DescribeStacks on its env\'s stacks only, not on "*" (F-22)', ({ role, drive, env }) => {
    expect(yamlGrant(role, "CloudFormationReadAndValidate")).toEqual({
      Action: [
        "cloudformation:ValidateTemplate",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStacks",
        "cloudformation:ListExports",
      ],
      Resource: ["*"],
    });
    // No DeleteStack and no drift actions: those are SchedDeployer's alone.
    expect(yamlGrant(role, drive)).toEqual({
      Action: [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:CreateChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ListChangeSets",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResource",
        "cloudformation:DescribeStackResources",
        "cloudformation:ListStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:TagResource",
      ],
      Resource: [
        `!Sub arn:\${AWS::Partition}:cloudformation:\${AWS::Region}:\${AWS::AccountId}:stack/sched-${env}-*/*`,
      ],
    });
  });
});

describe("the SchedDeployer permission set (infra/bootstrap/sched-deployer-policy.json; #270)", () => {
  it("names the six entitled models' ARNs in SpikesAndEvals, and no Bedrock Mantle action (F-6)", () => {
    const spikes = deployerGrant("SpikesAndEvals");
    expect(spikes).toEqual({
      Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      Resource: bedrockArns(undefined, "aws", "us-east-1", "<ACCOUNT_ID>"),
    });
    // A tripwire: a newly entitled profile changes the derived list, and this count is then changed on purpose.
    expect(spikes.Resource).toHaveLength(10);
  });

  it('keeps the two Transcribe streaming actions on "*" in a statement of their own (F-6)', () => {
    expect(deployerGrant("TranscribeStreaming")).toEqual({
      Action: ["transcribe:StartStreamTranscription", "transcribe:StartStreamTranscriptionWebSocket"],
      Resource: ["*"],
    });
  });

  it("lets SeedDemoUsers create, set the password of and read a user, and nothing more (F-7)", () => {
    expect(deployerGrant("SeedDemoUsers")).toEqual({
      Action: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminGetUser"],
      Resource: ["arn:aws:cognito-idp:us-east-1:<ACCOUNT_ID>:userpool/*"],
    });
  });

  it("names only table/sched-*/index/GSI1 in SeedAndEvalData, with its eight item actions (F-8)", () => {
    expect(deployerGrant("SeedAndEvalData")).toEqual({
      Action: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem",
        "dynamodb:BatchGetItem",
      ],
      Resource: [
        "arn:aws:dynamodb:us-east-1:<ACCOUNT_ID>:table/sched-*",
        ...INDEX.map((name) => `arn:aws:dynamodb:us-east-1:<ACCOUNT_ID>:table/sched-*/index/${name}`),
      ],
    });
  });

  it("can run drift detection and read its status (F-9)", () => {
    expect(deployerGrant("CloudFormationDriveSchedStacks")).toEqual({
      Action: [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:CreateChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ListChangeSets",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResource",
        "cloudformation:DescribeStackResources",
        "cloudformation:ListStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:TagResource",
        "cloudformation:DetectStackDrift",
        "cloudformation:DetectStackResourceDrift",
        "cloudformation:DescribeStackResourceDrifts",
      ],
      Resource: ["arn:aws:cloudformation:us-east-1:<ACCOUNT_ID>:stack/sched-*/*"],
    });
    // A detection ID is no ARN, so the status call can only be on "*" (verify first: the first run after the apply).
    expect(deployerGrant("CloudFormationReadAndValidate")).toEqual({
      Action: [
        "cloudformation:ValidateTemplate",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStacks",
        "cloudformation:DescribeStacks",
        "cloudformation:ListExports",
        "cloudformation:DescribeStackDriftDetectionStatus",
      ],
      Resource: ["*"],
    });
  });
});

describe("sched-cfn-exec's service grants (#270 second PR; F-3)", () => {
  const exec = block(/^ {2}CfnExecutionRole:$/, lines);
  const arn = (service: string, region: boolean, rest: string) =>
    `!Sub arn:\${AWS::Partition}:${service}:${region ? "${AWS::Region}" : ""}:\${AWS::AccountId}:${rest}`;

  const SERVICES = [
    {
      sid: "DynamoDbSchedTables",
      action: "dynamodb:*",
      resource: [arn("dynamodb", true, "table/sched-*"), arn("dynamodb", true, "table/sched-*/index/*")],
    },
    { sid: "LambdaSchedFunctions", action: "lambda:*", resource: [arn("lambda", true, "function:sched-*")] },
    {
      sid: "LogsSchedLambdaLogGroups",
      action: "logs:*",
      resource: [arn("logs", true, "log-group:/aws/lambda/sched-*")],
    },
    {
      sid: "CloudWatchSchedAlarmsAndDashboards",
      action: "cloudwatch:*",
      resource: [arn("cloudwatch", true, "alarm:sched-*"), arn("cloudwatch", false, "dashboard/sched-*")],
    },
    {
      sid: "S3SchedBuckets",
      action: "s3:*",
      resource: ["!Sub arn:${AWS::Partition}:s3:::sched-*", "!Sub arn:${AWS::Partition}:s3:::sched-*/*"],
    },
    { sid: "SsmSchedParameters", action: "ssm:*", resource: [arn("ssm", true, "parameter/sched/*")] },
    { sid: "CloudFrontDistributionsAndOacs", action: "cloudfront:*", resource: ["*"] },
    { sid: "ApiGatewayApis", action: "apigateway:*", resource: ["*"] },
    { sid: "CognitoUserPools", action: "cognito-idp:*", resource: ["*"] },
    { sid: "CognitoIdentityPools", action: "cognito-identity:*", resource: ["*"] },
  ];

  /** The services whose resources are named by a generated ID, or take none, so keep "*" (r1/Q-2 (a)). */
  const STARRED = SERVICES.filter((s) => s.resource.includes("*")).map((s) => s.sid);

  it.each(SERVICES)(
    "grants $action on exactly its named resources in $sid (F-3)",
    ({ sid, action, resource }) => {
      expect(yamlGrant("CfnExecutionRole", sid)).toEqual({ Action: [action], Resource: resource });
      expect(entries(yamlStatement("CfnExecutionRole", sid)).Effect).toBe("Allow");
    },
  );

  it("has no WorkloadServiceControlPlanes statement and no Events, X-Ray, SES or Bedrock action (F-3, A-3)", () => {
    const sids = exec.flatMap((l) => /^\s+- Sid: (\w+)$/.exec(l)?.[1] ?? []);
    expect(sids).not.toContain("WorkloadServiceControlPlanes");
    expect(sids.slice(0, SERVICES.length)).toEqual(SERVICES.map((s) => s.sid));
    expect(exec.filter((l) => /\b(events|xray|ses|bedrock):/.test(l))).toEqual([]);
  });

  it('lists the Allow statements with a "*" resource (a list item, quoted, trailing comment or not) as the four Sids that carry a reason comment (F-3, r1/Q-2 (a))', () => {
    const unquote = (v: string) => v.replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
    const statements = items(block(/^\s+Statement:$/, block(/^\s+PolicyDocument:$/, exec)));
    const starred = statements
      .filter((st) => entries(st).Effect === "Allow")
      .filter((st) => valuesOf(st, "Resource").some((r) => unquote(r) === "*"))
      .map((st) => entries(st).Sid);
    expect(starred).toEqual(STARRED);
    for (const sid of STARRED) {
      const at = exec.findIndex((l) => l.trim() === `- Sid: ${sid}`);
      const comment: string[] = [];
      for (let i = at - 1; /^\s*#/.test(exec[i] ?? ""); i--) comment.unshift((exec[i] ?? "").trim());
      expect(comment.join(" ")).toMatch(/(takes no resource|generated)/);
    }
  });
});
