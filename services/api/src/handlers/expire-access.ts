/**
 * The expiry job's Lambda entry point (#357, part 2), bundled by services/api/Makefile into `index.mjs`
 * (infra/stacks/api.yaml, `RequestAccessExpiryFunction`, present only where the request page is on, with its hourly
 * schedule). The logic is `lib/expire-access.ts`.
 */
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SystemClock } from "@sched/tools";
import { createDocumentClient } from "@sched/tools/dynamo";

import { createAccountData } from "../lib/account-data";
import { createDynamoAccessStore } from "../lib/access-store";
import { cognitoAdmin } from "../lib/cognito-admin";
import { expiryHandler } from "../lib/expire-access";
import { expiryConfigFromEnv } from "../lib/expiry-config";
import { withLambdaContext } from "../lib/observability/lambda";
import { createPowertoolsLogger, powertoolsLogger } from "../lib/observability/logger";

const config = expiryConfigFromEnv();
const logger = createPowertoolsLogger("expire-access");
const doc = createDocumentClient(new DynamoDBClient({}));

export const handler = withLambdaContext(
  logger,
  expiryHandler({
    store: createDynamoAccessStore({ tableName: config.tableName, doc }),
    admin: cognitoAdmin(new CognitoIdentityProviderClient({}), config.userPoolId),
    data: createAccountData({ tableName: config.tableName, doc }),
    clock: new SystemClock(),
    log: powertoolsLogger(logger),
  }),
);
