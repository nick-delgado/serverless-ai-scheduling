/**
 * `POST /api/request-access` (#357). Lambda entry point, bundled by services/api/Makefile into `index.mjs`
 * (infra/stacks/api.yaml, `RequestAccessFunction`, present only where the page is on). A buffered JSON response;
 * the route has no authorizer, so the handler's own bot check (`lib/bot-check.ts`) and caps are its only gates.
 *
 * Log lines go through a Powertools Logger with the invocation's Lambda context. They carry the request ID, the
 * outcome and timings only (`lib/issue-access.ts`).
 */
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SystemClock } from "@sched/tools";
import { createDocumentClient } from "@sched/tools/dynamo";

import { requestAccessConfigFromEnv } from "../lib/access-config";
import { createDynamoAccessStore } from "../lib/access-store";
import { createTurnstileVerifier } from "../lib/bot-check";
import { cognitoAdmin } from "../lib/cognito-admin";
import { requestAccessProxyHandler } from "../lib/issue-access";
import { withLambdaContext } from "../lib/observability/lambda";
import { createPowertoolsLogger, powertoolsLogger } from "../lib/observability/logger";

const config = requestAccessConfigFromEnv();
const logger = createPowertoolsLogger("request-access");

export const handler = withLambdaContext(
  logger,
  requestAccessProxyHandler({
    verifier: createTurnstileVerifier({
      secret: config.turnstileSecret,
      expectedHostname: config.expectedHostname,
    }),
    store: createDynamoAccessStore({
      tableName: config.tableName,
      doc: createDocumentClient(new DynamoDBClient({})),
    }),
    admin: cognitoAdmin(new CognitoIdentityProviderClient({}), config.userPoolId),
    clock: new SystemClock(),
    config: { caps: config.caps, expiryHours: config.expiryHours },
    log: powertoolsLogger(logger),
  }),
);
