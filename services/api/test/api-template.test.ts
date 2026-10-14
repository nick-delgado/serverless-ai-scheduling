/**
 * `infra/stacks/api.yaml` must match `packages/agent/src/profiles.ts`: the `AgentModelProfile` parameter
 * allows exactly the entitled profiles, and the chat role may invoke each of them and each one's refusal
 * fallback (ADR-010). Fails if either side drifts. Reads the template as text, through the shared reader
 * `scripts/test/yaml-text.ts` (#157).
 */
import { readFileSync } from "node:fs";

import { MODEL_PROFILES, REFUSAL_FALLBACKS } from "@sched/agent";
import { ChatErrorCode } from "@sched/contracts";
import { NOTIFICATION_FAILED_METRIC } from "@sched/tools/ses";
import { describe, expect, it } from "vitest";

import { ENV_DIMENSION, ERROR_CODE_DIMENSION, METRIC } from "../src/lib/observability/metrics";

import { block, bodyLines, entries, text } from "../../../scripts/test/yaml-text";

const template = readFileSync(new URL("../../../infra/stacks/api.yaml", import.meta.url), "utf8");
const lines = template.split("\n");

const entitled = Object.values(MODEL_PROFILES).filter((p) => p.entitled);

/** The resource ARNs the chat role may invoke (the `InvokeAgentModels` statement). */
function invokeResources(): string[] {
  const resources = block(/^\s+Resource:$/, block(/^\s+- Sid: InvokeAgentModels$/, lines));
  return resources.flatMap((l) => /^\s*- !Sub (\S+)$/.exec(l)?.[1] ?? []);
}

describe("infra/stacks/api.yaml matches the model profiles", () => {
  it("allows exactly the entitled profiles as AgentModelProfile", () => {
    const { AllowedValues = "" } = entries(block(/^ {2}AgentModelProfile:$/, lines));
    const allowed = AllowedValues.replace(/^\[(.*)\]$/, "$1")
      .split(",")
      .map((v) => v.trim());
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

/** One top-level resource's YAML lines (a miss throws). */
const resource = (name: string): string[] => block(new RegExp(`^ {2}${name}:$`), lines);

describe("infra/stacks/api.yaml: POST /api/session (#18)", () => {
  const fnLines = resource("SessionFunction");
  const fn = text(fnLines);
  /**
   * The lines under `key:` in the function, with comments and blank lines dropped. Compared exactly, so any added
   * policy, resource or variable shows up.
   */
  const section = (key: string): string[] => bodyLines(block(new RegExp(`^\\s+${key}:$`), fnLines));
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
    expect(section("Policies")).toEqual([
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
    expect(section("Variables")).toEqual([
      '  TABLE_NAME: !Sub "{{resolve:ssm:/sched/${Env}/data/table-name}}"',
      "  NODE_OPTIONS: --enable-source-maps",
    ]);
  });

  it("routes POST /api/session through the Cognito authorizer to the session function", () => {
    const post = text(block(/^ {12}post:$/, block(/^ {10}\/api\/session:$/, lines)));
    expect(post).toMatch(/^ {12}post:\n/m);
    expect(post).toMatch(/security:\n\s*- CognitoUserPool: \[\]/);
    expect(post).toContain("type: aws_proxy");
    expect(post).toContain("/functions/${SessionFunction.Arn}/invocations");
    expect(template).not.toMatch(/\/api\/session:\n\s*get:/);
  });

  it("lets API Gateway invoke the session function for POST /api/session only", () => {
    const permission = text(resource("SessionApiInvokePermission"));
    expect(permission).toContain("FunctionName: !GetAtt SessionFunction.Arn");
    expect(permission).toMatch(/SourceArn: !Sub \S+:\$\{ChatApi\}\/\*\/POST\/api\/session$/m);
  });
});

describe("infra/stacks/api.yaml: observability (#38)", () => {
  const chatLines = resource("ChatFunction");
  const chat = text(chatLines);

  /** The dashboard body as CloudWatch receives it, with each `${...}` replaced by its name in angle brackets. */
  function dashboard(): { widgets: { type: string; properties: Record<string, unknown> }[] } {
    const body = bodyLines(block(/^\s+DashboardBody: !Sub \|$/, resource("ApiDashboard"))).join("\n");
    return JSON.parse(body.replace(/\$\{([^}]+)\}/g, "<$1>")) as ReturnType<typeof dashboard>;
  }
  const widgets = dashboard().widgets;
  const titled = (start: string) => {
    const found = widgets.filter((w) => String(w.properties.title).startsWith(start));
    expect(found, start).toHaveLength(1);
    return found[0]?.properties ?? {};
  };
  type Row = (string | Record<string, unknown>)[];
  const rows = (props: Record<string, unknown>): Row[] => props.metrics as Row[];

  it("traces the chat function with X-Ray, and nothing else, with no response or error capture", () => {
    expect(chat).toMatch(/^ {6}Tracing: Active$/m);
    expect(template.match(/Tracing:/g)).toHaveLength(1);
    const variables = entries(block(/^\s+Variables:$/, chatLines));
    expect(variables).toMatchObject({
      POWERTOOLS_TRACER_CAPTURE_RESPONSE: "false",
      POWERTOOLS_TRACER_CAPTURE_ERROR: "false",
    });
  });

  it("gives the failed-notification alarm no action (owner decision r1/Q-1 (a))", () => {
    expect(text(resource("NotificationFailedAlarm"))).not.toMatch(/Actions:/);
  });

  it("charts exactly the catalogue's metrics, each under Env, with NotificationFailed", () => {
    const sched = widgets
      .flatMap((w) => (w.type === "metric" ? rows(w.properties) : []))
      .filter((r) => r[0] === "Sched");
    const names = new Set(sched.map((r) => r[1]));
    expect([...names].sort()).toEqual([...Object.values(METRIC), NOTIFICATION_FAILED_METRIC.name].sort());
    for (const row of sched) expect(row.slice(2, 4)).toEqual([ENV_DIMENSION, "<Env>"]);
    expect(widgets.every((w) => w.type !== "metric" || w.properties.region === "<AWS::Region>")).toBe(true);
  });

  it("shows TTFT and turn latency at p50 and p95 (NFR-001)", () => {
    for (const [title, name] of [
      ["Time to first text_delta", METRIC.timeToFirstText],
      ["Turn latency to done", METRIC.turnLatency],
    ] as const) {
      const stats = rows(titled(title)).map((r) => [r[1], (r[4] as { stat?: string }).stat]);
      expect(stats).toEqual([
        [name, "p50"],
        [name, "p95"],
      ]);
    }
  });

  it("sums the tokens, cache reads included", () => {
    const props = titled("Tokens");
    expect(props.stat).toBe("Sum");
    expect(rows(props).map((r) => r[1])).toEqual([
      METRIC.inputTokens,
      METRIC.outputTokens,
      METRIC.cacheReadTokens,
      METRIC.cacheWriteTokens,
    ]);
  });

  it("shows turn errors by every chat error code beside both functions' Lambda errors", () => {
    const props = titled("Turns, turn errors");
    expect(props.stat).toBe("Sum");
    const all = rows(props);
    const codes = all.filter((r) => r[1] === METRIC.turnErrors).map((r) => r.slice(4, 6));
    expect(codes).toEqual(ChatErrorCode.options.map((c) => [ERROR_CODE_DIMENSION, c]));
    expect(all.filter((r) => r[0] === "AWS/Lambda").map((r) => r.slice(1, 4))).toEqual([
      ["Errors", "FunctionName", "<ChatFunction>"],
      ["Errors", "FunctionName", "<SessionFunction>"],
    ]);
  });

  it("shows the tool error rate as ToolErrors / ToolCalls", () => {
    const [expression, ...metrics] = rows(titled("Tool error rate"));
    const ids = Object.fromEntries(metrics.map((r) => [(r[4] as { id: string }).id, r[1]]));
    const math = (expression?.[0] as { expression: string }).expression;
    const [, errors, calls] = /^100 \* (\w+) \/ (\w+)$/.exec(math) ?? [];
    expect([ids[errors ?? ""], ids[calls ?? ""]]).toEqual([METRIC.toolErrors, METRIC.toolCalls]);
  });

  it("shows the failed-notification alarm's state beside its metric", () => {
    const props = titled("Failed staff notifications");
    expect(rows(props)).toEqual([["Sched", NOTIFICATION_FAILED_METRIC.name, "Env", "<Env>"]]);
    expect(props.annotations).toEqual({ alarms: ["<NotificationFailedAlarm.Arn>"] });
    const alarm = widgets.find((w) => w.type === "alarm");
    expect(alarm?.properties.alarms).toEqual(["<NotificationFailedAlarm.Arn>"]);
  });
});
