/**
 * `infra/stacks/api.yaml` must match `packages/agent/src/profiles.ts`: the `AgentModelProfile` parameter
 * allows exactly the entitled profiles, and the chat role may invoke each of them and each one's refusal
 * fallback (ADR-010). Fails if either side drifts. Reads the template as text, through the shared reader
 * `scripts/test/yaml-text.ts` (#157).
 */
import { readFileSync } from "node:fs";

import { MODEL_PROFILES, REFUSAL_FALLBACKS } from "@sched/agent";
import { ChatErrorCode } from "@sched/contracts";
import { createTableInput } from "@sched/tools/dynamo";
import { NOTIFICATION_FAILED_METRIC } from "@sched/tools/ses";
import { describe, expect, it } from "vitest";

import { DEFAULT_DAILY_TURN_CAP, DEFAULT_ENV_DAILY_TURN_CAP } from "../src/lib/chat-turn";
import { ENV_DIMENSION, ERROR_CODE_DIMENSION, METRIC } from "../src/lib/observability/metrics";

import { block, bodyLines, childBlocks, entries, items, text } from "../../../scripts/test/yaml-text";

const template = readFileSync(new URL("../../../infra/stacks/api.yaml", import.meta.url), "utf8");
const lines = template.split("\n");

const entitled = Object.values(MODEL_PROFILES).filter((p) => p.entitled);

/** One top-level resource's YAML lines (a miss throws). */
const resource = (name: string): string[] => block(new RegExp(`^ {2}${name}:$`), lines);
const chatLines = resource("ChatFunction");

/** One method's block in the API's OpenAPI body (`post` under `/api/chat`, say). */
const method = (path: string, verb: string): string[] =>
  block(new RegExp(`^ {12}${verb}:$`), block(new RegExp(`^ {10}${path.replace(/[/]/g, "\\/")}:$`), lines));

/**
 * The resources the chat role may invoke (the `InvokeAgentModels` statement): every list item under `Resource:`, whatever
 * its form (`!Sub`, a plain or quoted string, a trailing comment), so no form escapes the checks (#39).
 */
function invokeResources(): string[] {
  const resources = block(/^\s+Resource:$/, block(/^\s+- Sid: InvokeAgentModels$/, chatLines));
  return items(resources).map((item) =>
    (item[0] ?? "")
      .replace(/^\s*-\s+/, "")
      .replace(/\s+#.*$/, "")
      .replace(/^!Sub\s+/, "")
      .replace(/^(["'])(.*)\1$/, "$2"),
  );
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
        // A US cross-region inference profile, plus the foundation model it routes to in any region: that model's
        // exact ID, with no trailing `*` that would match other models (#39, r1/Q-2 (a)).
        expect(arns).toContain(
          `arn:\${AWS::Partition}:bedrock:\${AWS::Region}:\${AWS::AccountId}:inference-profile/${modelId}`,
        );
        expect(arns).toContain(
          `arn:\${AWS::Partition}:bedrock:*::foundation-model/${modelId.slice("us.".length)}`,
        );
      } else {
        expect(arns).toContain(`arn:\${AWS::Partition}:bedrock:\${AWS::Region}::foundation-model/${modelId}`);
      }
    }
  });

  it("names every model ARN exactly: no wildcard but the region of a foundation model (#39)", () => {
    expect(
      invokeResources().filter((a) => a.replace(/:bedrock:\*::foundation-model\//, "").includes("*")),
    ).toEqual([]);
  });

  it("only uses entitled profiles as refusal fallbacks for entitled profiles", () => {
    for (const profile of entitled) {
      expect(MODEL_PROFILES[REFUSAL_FALLBACKS[profile.name]].entitled, profile.name).toBe(true);
    }
  });
});

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
    const post = text(method("/api/session", "post"));
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
  const chat = text(chatLines);

  /** The dashboard body as CloudWatch receives it, with each `${...}` replaced by its name in angle brackets. */
  function dashboard(): {
    widgets: { type: string; x: number; width: number; properties: Record<string, unknown> }[];
  } {
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
    // A metric widget can't carry both metrics and an alarm annotation, so the state is its own widget.
    const metric = widgets.find((w) => w.properties === props);
    const alarm = widgets.find((w) => w.type === "alarm");
    expect(alarm?.properties.alarms).toEqual(["<NotificationFailedAlarm.Arn>"]);
    expect(widgets.filter((w) => w.type === "alarm")).toHaveLength(1);
    expect(Number(alarm?.x)).toBe(Number(metric?.x) + Number(metric?.width));
  });
});

describe("the expiry job (#357, part 2)", () => {
  const fn = (): string[] => resource("RequestAccessExpiryFunction");

  it("runs hourly from a SAM Schedule event, its only event, with no API route", () => {
    expect(bodyLines(block(/^\s+Events:$/, fn()))).toEqual([
      "  Hourly:",
      "    Type: Schedule",
      "    Properties:",
      "      Schedule: rate(1 hour)",
      "      Description: Run the reviewer-account expiry job (#357).",
    ]);
    expect(template).not.toContain("RequestAccessExpiryFunction.Arn}/invocations");
    expect(template).not.toContain("Type: Api");
  });

  it("gives the job the table and the pool, and a 5-minute timeout", () => {
    expect(entries(block(/^\s+Variables:$/, fn()))).toEqual({
      TABLE_NAME: '!Sub "{{resolve:ssm:/sched/${Env}/data/table-name}}"',
      USER_POOL_ID: '!Sub "{{resolve:ssm:/sched/${Env}/auth/user-pool-id}}"',
      NODE_OPTIONS: "--enable-source-maps",
    });
    expect(entries(block(/^ {4}Properties:$/, fn())).Timeout).toBe("300");
  });

  it("grants only the registry query, item reads, deletes and updates on the base table and three Cognito calls on this env's pool", () => {
    // The whole Policies list: no BatchWriteItem (the boundary has none), no PutItem, no Scan, no index, no wildcard.
    expect(bodyLines(block(/^\s+Policies:$/, fn())).filter((l) => !/^\s+#/.test(l))).toEqual([
      '  - Version: "2012-10-17"',
      "    Statement:",
      "      - Sid: RegistryAndAccountData",
      "        Effect: Allow",
      "        Action:",
      "          - dynamodb:Query",
      "          - dynamodb:GetItem",
      "          - dynamodb:DeleteItem",
      "          - dynamodb:UpdateItem",
      "        Resource:",
      '          - !Sub "{{resolve:ssm:/sched/${Env}/data/table-arn}}"',
      "      - Sid: DeleteTemporaryUsers",
      "        Effect: Allow",
      "        Action:",
      "          - cognito-idp:AdminGetUser",
      "          - cognito-idp:AdminUserGlobalSignOut",
      "          - cognito-idp:AdminDeleteUser",
      "        Resource:",
      '          - !Sub "{{resolve:ssm:/sched/${Env}/auth/user-pool-arn}}"',
    ]);
    expect(fn().join("\n")).not.toMatch(/^ {6}Role:/m);
  });

  it("builds the expiry handler with its own Makefile target", () => {
    const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
    expect(makefile).toMatch(
      /^build-RequestAccessExpiryFunction: check-root\n\t.*services\/api\/src\/handlers\/expire-access\.ts /m,
    );
    expect(text(fn())).toContain("BuildMethod: makefile");
  });

  it("keeps the 14-day log retention, in its own log group", () => {
    expect(entries(block(/^ {4}Properties:$/, resource("RequestAccessExpiryLogGroup")))).toMatchObject({
      LogGroupName: "!Sub /aws/lambda/sched-${Env}-api-request-access-expiry",
      RetentionInDays: "14",
    });
    expect(entries(block(/^\s+LoggingConfig:$/, fn())).LogGroup).toBe("!Ref RequestAccessExpiryLogGroup");
  });
});

describe("infra/stacks/api.yaml: least privilege and abuse limits (#39, ADR-009)", () => {
  const dataTemplate = readFileSync(new URL("../../../infra/stacks/data.yaml", import.meta.url), "utf8");
  /** The table's indexes, from the CreateTable input that `packages/tools` keeps in step with data.yaml. */
  const indexes = (createTableInput("t").GlobalSecondaryIndexes ?? []).map((i) => i.IndexName);

  it("lets the chat role make item reads and conditional writes on the base table and GSI1 only", () => {
    // Compared exactly, so an added action (Scan, DeleteItem), another index or an `index/*` fails here.
    const table = '"{{resolve:ssm:/sched/${Env}/data/table-arn}}';
    expect(bodyLines(block(/^\s+- Sid: SingleTableItems$/, chatLines))).toEqual([
      "  Effect: Allow",
      "  Action:",
      "    - dynamodb:GetItem",
      "    - dynamodb:Query",
      "    - dynamodb:PutItem",
      "    - dynamodb:UpdateItem",
      "    - dynamodb:ConditionCheckItem",
      "  Resource:",
      `    - !Sub ${table}"`,
      ...indexes.map((name) => `    - !Sub ${table}/index/${String(name)}"`),
    ]);
    // GSI1 is the table's only index, in infra/stacks/data.yaml and in createTableInput alike.
    expect(indexes).toEqual(["GSI1"]);
    expect([...dataTemplate.matchAll(/IndexName: (\S+)/g)].map((m) => m[1])).toEqual(indexes);
  });

  it("routes POST /api/chat through the Cognito authorizer to the chat function", () => {
    // The patient's identity is the verified token's `sub` (ADR-005), so a method without the authorizer has none.
    const post = text(method("/api/chat", "post"));
    expect(post).toMatch(/security:\n\s*- CognitoUserPool: \[\]/);
    expect(post).toContain("/functions/${ChatFunction.Arn}/response-streaming-invocations");
  });

  it("puts every method of the API behind the Cognito authorizer, except the one public route, which this env's pool validates", () => {
    const paths = childBlocks(block(/^ {8}paths:$/, lines));
    // The one named exception (#357, r1/A-5): every other path stays pinned.
    const headers = paths.map((path) => (path[0] ?? "").trim());
    expect(headers.map((h) => h.replace(/:.*$/, "")).sort()).toEqual(
      ["/api/chat", "/api/request-access", "/api/session"].sort(),
    );
    const guarded = paths.filter((path) => !(path[0] ?? "").includes("/api/request-access"));
    const methods = guarded.flatMap((path) => childBlocks(path));
    expect(methods.length).toBe(2);
    for (const m of methods) expect(text(m), m[0]).toMatch(/^ {14}security:\n {16}- CognitoUserPool: \[\]$/m);
    expect(bodyLines(block(/^ {12}CognitoUserPool:$/, lines))).toEqual([
      "  type: apiKey",
      "  name: Authorization",
      "  in: header",
      "  x-amazon-apigateway-authtype: cognito_user_pools",
      "  x-amazon-apigateway-authorizer:",
      "    type: cognito_user_pools",
      "    providerARNs:",
      '      - !Sub "{{resolve:ssm:/sched/${Env}/auth/user-pool-arn}}"',
    ]);
  });

  it("throttles every method of the stage at rate 5 and burst 10", () => {
    expect(bodyLines(block(/^\s+MethodSettings:$/, resource("ChatApi")))).toEqual([
      '  - ResourcePath: "/*"',
      '    HttpMethod: "*"',
      "    ThrottlingRateLimit: 5",
      "    ThrottlingBurstLimit: 10",
    ]);
  });

  it("reserves 5 concurrent executions for the chat function (#273, owner decision r1/Q-2 (c))", () => {
    expect(entries(block(/^ {4}Properties:$/, chatLines))).toMatchObject({
      ReservedConcurrentExecutions: "5",
    });
  });

  it("caps each patient at the handler's default of 50 turns a day, and passes the cap to the chat function", () => {
    expect(DEFAULT_DAILY_TURN_CAP).toBe(50);
    expect(entries(block(/^ {2}DailyTurnCap:$/, lines))).toMatchObject({
      Default: String(DEFAULT_DAILY_TURN_CAP),
      MinValue: "1",
    });
    expect(entries(block(/^\s+Variables:$/, chatLines))).toMatchObject({
      DAILY_TURN_CAP: "!Ref DailyTurnCap",
    });
  });

  it("caps the whole env at 200 turns a day unless it overrides, and passes the cap to the chat function (#356, owner decision r1/Q-2 (a))", () => {
    expect(DEFAULT_ENV_DAILY_TURN_CAP).toBe(200);
    expect(entries(block(/^ {2}EnvDailyTurnCap:$/, lines))).toMatchObject({
      Type: "Number",
      Default: String(DEFAULT_ENV_DAILY_TURN_CAP),
      MinValue: "1",
    });
    expect(entries(block(/^\s+Variables:$/, chatLines))).toMatchObject({
      ENV_DAILY_TURN_CAP: "!Ref EnvDailyTurnCap",
    });
  });
});

describe("the request-access route (#357)", () => {
  const publicPath = (): string[] => block(/^ {10}\/api\/request-access: !If$/, lines);
  const accessResources = [
    "RequestAccessLogGroup",
    "RequestAccessFunction",
    "RequestAccessApiInvokePermission",
    "RequestAccessExpiryLogGroup",
    "RequestAccessExpiryFunction",
  ];

  it("is the API's one method with no authorizer: no security, an integration with its own function, only where RequestAccessOn", () => {
    const path = text(publicPath());
    expect(path).toMatch(/- RequestAccessOn\n/);
    expect(path).toMatch(/- !Ref AWS::NoValue\s*$/);
    expect(path).toContain("- post:");
    expect(path).not.toContain("security");
    expect(path).not.toContain("CognitoUserPool");
    expect(path).toContain("/functions/${RequestAccessFunction.Arn}/invocations");
    // An ordinary Lambda proxy integration: the route answers with one buffered JSON body.
    expect(path).toContain("type: aws_proxy");
    expect(path).not.toContain("responseTransferMode");
  });

  it("is on in demo, or when the RequestAccess parameter is on (default off): the page, its function, its route and the expiry job together", () => {
    expect(entries(block(/^ {2}RequestAccess:$/, lines))).toMatchObject({
      Type: "String",
      Default: "off",
      AllowedValues: '["on", "off"]',
    });
    expect(bodyLines(block(/^ {2}RequestAccessOn: !Or$/, block(/^Conditions:$/, lines)))).toEqual([
      "  - !Equals [!Ref Env, demo]",
      '  - !Equals [!Ref RequestAccess, "on"]',
    ]);
  });

  it("puts exactly the two log groups, the two functions and the invoke permission under that condition", () => {
    const conditioned = lines.flatMap((line, i) => {
      if (!/^ {2}[A-Za-z0-9]+:$/.test(line)) return [];
      const own = block(new RegExp(`^ {2}${line.trim().replace(":", "")}:$`), lines);
      return own.some((l) => /^ {4}Condition: RequestAccessOn$/.test(l))
        ? [lines[i]?.trim().replace(":", "")]
        : [];
    });
    expect(conditioned.sort()).toEqual([...accessResources].sort());
  });

  it("defaults the caps to 10 a day and 5 at once, expires accounts after 24 hours, each at least 1", () => {
    for (const [name, def] of [
      ["RequestAccessDailyCap", "10"],
      ["RequestAccessActiveCap", "5"],
      ["RequestAccessExpiryHours", "24"],
    ] as const) {
      expect(entries(block(new RegExp(`^ {2}${name}:$`), lines)), name).toMatchObject({
        Type: "Number",
        Default: def,
        MinValue: "1",
      });
    }
  });

  it("takes the Turnstile secret as a NoEcho parameter with an empty default", () => {
    // `entries` drops an empty value, so the default is read from the block's text.
    const secret = block(/^ {2}TurnstileSecret:$/, lines);
    expect(entries(secret)).toMatchObject({ Type: "String", NoEcho: "true" });
    expect(text(secret)).toContain('Default: ""');
  });

  it("gives the function the table, the pool, the secret, the hostname and the three settings", () => {
    const fn = resource("RequestAccessFunction");
    expect(entries(block(/^\s+Variables:$/, fn))).toEqual({
      TABLE_NAME: '!Sub "{{resolve:ssm:/sched/${Env}/data/table-name}}"',
      USER_POOL_ID: '!Sub "{{resolve:ssm:/sched/${Env}/auth/user-pool-id}}"',
      TURNSTILE_SECRET: "!Ref TurnstileSecret",
      TURNSTILE_EXPECTED_HOSTNAME: "!Ref TurnstileExpectedHostname",
      ACCESS_DAILY_CAP: "!Ref RequestAccessDailyCap",
      ACCESS_ACTIVE_CAP: "!Ref RequestAccessActiveCap",
      ACCESS_EXPIRY_HOURS: "!Ref RequestAccessExpiryHours",
      NODE_OPTIONS: "--enable-source-maps",
    });
  });

  it("grants only the two item writes on the base table and four Cognito admin calls on this env's pool", () => {
    const fn = resource("RequestAccessFunction");
    // The whole Policies list, so a third statement, a SAM policy template, another resource or a wildcard each fails.
    expect(bodyLines(block(/^\s+Policies:$/, fn))).toEqual([
      '  - Version: "2012-10-17"',
      "    Statement:",
      "      - Sid: RegistryAndProfileWrites",
      "        Effect: Allow",
      "        Action:",
      "          - dynamodb:PutItem",
      "          - dynamodb:UpdateItem",
      "        Resource:",
      '          - !Sub "{{resolve:ssm:/sched/${Env}/data/table-arn}}"',
      "      - Sid: CreateAndDeleteTemporaryUsers",
      "        Effect: Allow",
      "        Action:",
      "          - cognito-idp:AdminCreateUser",
      "          - cognito-idp:AdminSetUserPassword",
      "          - cognito-idp:AdminGetUser",
      "          - cognito-idp:AdminDeleteUser",
      "        Resource:",
      '          - !Sub "{{resolve:ssm:/sched/${Env}/auth/user-pool-arn}}"',
    ]);
    // No role of its own that would bypass Policies.
    expect(fn.join("\n")).not.toMatch(/^ {6}Role:/m);
  });

  it("builds the request-access handler with its own Makefile target", () => {
    const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
    expect(makefile).toMatch(
      /^build-RequestAccessFunction: check-root\n\t.*services\/api\/src\/handlers\/request-access\.ts /m,
    );
    expect(text(resource("RequestAccessFunction"))).toContain("BuildMethod: makefile");
  });

  it("declares TurnstileExpectedHostname as a string that is empty by default", () => {
    const hostname = block(/^ {2}TurnstileExpectedHostname:$/, lines);
    expect(entries(hostname).Type).toBe("String");
    expect(text(hostname)).toContain('Default: ""');
  });

  it("lets API Gateway invoke the function for POST /api/request-access only", () => {
    const permission = resource("RequestAccessApiInvokePermission");
    expect(bodyLines(permission).find((l) => l.includes("SourceArn"))).toContain(
      "${ChatApi}/*/POST/api/request-access",
    );
    expect(entries(block(/^ {4}Properties:$/, permission)).FunctionName).toBe(
      "!GetAtt RequestAccessFunction.Arn",
    );
  });

  it("keeps the 14-day log retention of the other functions", () => {
    expect(entries(block(/^ {4}Properties:$/, resource("RequestAccessLogGroup")))).toMatchObject({
      LogGroupName: "!Sub /aws/lambda/sched-${Env}-api-request-access",
      RetentionInDays: "14",
    });
  });

  it("publishes whether the page is on, for the web build", () => {
    expect(entries(block(/^ {4}Properties:$/, resource("RequestAccessParam")))).toEqual({
      Name: "!Sub /sched/${Env}/api/request-access",
      Type: "String",
      Value: '!If [RequestAccessOn, "on", "off"]',
    });
  });

  it("adds no access logging to the stage, which would record callers' addresses (A-7)", () => {
    expect(template).not.toContain("AccessLogSetting");
    expect(template).not.toContain("DestinationArn");
  });
});
