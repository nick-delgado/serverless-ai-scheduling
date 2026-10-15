/**
 * `POST /api/session` (S3-04, #18). Lambda entry point, bundled by services/api/Makefile into `index.mjs`
 * (infra/stacks/api.yaml, `SessionFunction`). A buffered JSON response: the templated greeting and the
 * current conversation (`lib/session.ts`). No model call, so this bundle carries no `@sched/agent`.
 *
 * The DynamoDB repositories and the clock are created once per execution environment. Log lines go through
 * a Powertools Logger with the invocation's Lambda context (#38, assumption A-7); no metrics, no X-Ray.
 */
import { SystemClock } from "@sched/tools";

import { createAwsStores } from "../lib/aws";
import { requireEnv } from "../lib/env";
import { withLambdaContext } from "../lib/observability/lambda";
import { createPowertoolsLogger, powertoolsLogger } from "../lib/observability/logger";
import { sessionProxyHandler } from "../lib/session";

const clock = new SystemClock();
const { repos } = createAwsStores({ tableName: requireEnv(process.env, "TABLE_NAME"), clock });

const logger = createPowertoolsLogger("session");

export const handler = withLambdaContext(
  logger,
  sessionProxyHandler({ repos, clock, log: powertoolsLogger(logger) }),
);
