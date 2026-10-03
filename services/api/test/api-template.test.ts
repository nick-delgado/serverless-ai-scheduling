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
