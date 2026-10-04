/**
 * `infra/stacks/api.yaml` must match `packages/agent/src/profiles.ts`: the `AgentModelProfile` parameter
 * allows exactly the entitled profiles, and the chat role may invoke each of them and each one's refusal
 * fallback (ADR-010). Fails if either side drifts. Reads the template as text, like
 * `packages/tools/test/dynamo/table.test.ts`.
 */
import { readFileSync } from "node:fs";

import { MODEL_PROFILES, REFUSAL_FALLBACKS } from "@sched/agent";
import { describe, expect, it } from "vitest";

const template = readFileSync(new URL("../../../infra/stacks/api.yaml", import.meta.url), "utf8");

const entitled = Object.values(MODEL_PROFILES).filter((p) => p.entitled);

/** The resource ARNs the chat role may invoke (the `InvokeAgentModels` statement). */
function invokeResources(): string[] {
  const statement = template.slice(template.indexOf("Sid: InvokeAgentModels"));
  const resources = statement.slice(statement.indexOf("Resource:"), statement.search(/\n\s*\n|\n {2}\w/));
  return [...resources.matchAll(/^\s*- !Sub (\S+)$/gm)].map((m) => m[1] ?? "");
}

describe("infra/stacks/api.yaml matches the model profiles", () => {
  it("allows exactly the entitled profiles as AgentModelProfile", () => {
    const match = /AgentModelProfile:[\s\S]*?AllowedValues: \[([^\]]*)\]/.exec(template);
    const allowed = (match?.[1] ?? "").split(",").map((v) => v.trim());
    expect([...allowed].sort()).toEqual(entitled.map((p) => p.name).sort());
  });

  it("lets the chat role invoke every entitled profile's model", () => {
    const arns = invokeResources();
    expect(arns.length).toBeGreaterThan(0);
    for (const { modelId } of entitled) {
      if (modelId.startsWith("us.")) {
        // A US cross-region inference profile, plus the foundation model it routes to in any region.
        expect(arns).toContain(
          `arn:\${AWS::Partition}:bedrock:\${AWS::Region}:\${AWS::AccountId}:inference-profile/${modelId}`,
        );
        const foundation = modelId.slice("us.".length);
        expect(
          arns.some((a) =>
            new RegExp(
              `^arn:\\$\\{AWS::Partition\\}:bedrock:\\*::foundation-model/${foundation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*?$`,
            ).test(a),
          ),
          `foundation-model ARN for ${modelId}`,
        ).toBe(true);
      } else {
        expect(arns).toContain(`arn:\${AWS::Partition}:bedrock:\${AWS::Region}::foundation-model/${modelId}`);
      }
    }
  });

  it("only uses entitled profiles as refusal fallbacks for entitled profiles", () => {
    for (const profile of entitled) {
      expect(MODEL_PROFILES[REFUSAL_FALLBACKS[profile.name]].entitled, profile.name).toBe(true);
    }
  });
});

/** One top-level resource's YAML, from its name to the next resource at the same indent. */
function resourceBlock(name: string): string {
  const start = template.indexOf(`\n  ${name}:\n`);
  if (start < 0) return "";
  const rest = template.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[A-Za-z]/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/**
 * The lines under `key:` in a block, up to the next line indented no deeper than the key, with comments
 * and blank lines dropped. Compared exactly, so any added policy, resource or variable shows up.
 */
function yamlSection(block: string, key: string): string[] {
  const lines = block.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^ *${key}:\\s*$`).test(l));
  if (at < 0) return [];
  const indent = (lines[at] ?? "").search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.search(/\S/) <= indent) break;
    body.push(line.slice(indent).trimEnd());
  }
  return body;
}

describe("infra/stacks/api.yaml: POST /api/session (#18)", () => {
  const fn = resourceBlock("SessionFunction");
  const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");

  it("builds the session handler with its own Makefile target", () => {
    expect(fn).toContain("BuildMethod: makefile");
    expect(makefile).toMatch(
      /^build-SessionFunction: check-root\n\t.*services\/api\/src\/handlers\/session\.ts /m,
    );
  });

  it("lets the session function read the base table and nothing else", () => {
    // The whole Policies list, so a second statement, a SAM policy template, another resource or a
    // wildcard each fails here.
    expect(yamlSection(fn, "Policies")).toEqual([
      '  - Version: "2012-10-17"',
      "    Statement:",
      "      - Sid: SessionReads",
      "        Effect: Allow",
      "        Action:",
      "          - dynamodb:GetItem",
      "          - dynamodb:Query",
      "        Resource:",
      '          - !Sub "{{resolve:ssm:/sched/${Env}/data/table-arn}}"',
    ]);
    // No role of its own that would bypass Policies.
    expect(fn).not.toMatch(/^ {6}Role:/m);
    expect(fn).not.toContain("bedrock");
  });

  it("gives the session function the table name and nothing else", () => {
    expect(yamlSection(fn, "Variables")).toEqual([
      '  TABLE_NAME: !Sub "{{resolve:ssm:/sched/${Env}/data/table-name}}"',
      "  NODE_OPTIONS: --enable-source-maps",
    ]);
  });

  it("routes POST /api/session through the Cognito authorizer to the session function", () => {
    const route = template.slice(template.indexOf("          /api/session:"));
    const post = route.slice(0, route.indexOf("timeoutInMillis"));
    expect(post).toMatch(/^ {12}post:\n/m);
    expect(post).toMatch(/security:\n\s*- CognitoUserPool: \[\]/);
    expect(post).toContain("type: aws_proxy");
    expect(post).toContain("/functions/${SessionFunction.Arn}/invocations");
    expect(template).not.toMatch(/\/api\/session:\n\s*get:/);
  });

  it("lets API Gateway invoke the session function for POST /api/session only", () => {
    const permission = resourceBlock("SessionApiInvokePermission");
    expect(permission).toContain("FunctionName: !GetAtt SessionFunction.Arn");
    expect(permission).toMatch(/SourceArn: !Sub \S+:\$\{ChatApi\}\/\*\/POST\/api\/session$/m);
  });
});
