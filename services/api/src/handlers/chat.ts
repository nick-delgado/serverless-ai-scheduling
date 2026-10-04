/**
 * `POST /api/chat` (S3-03, #17). Lambda entry point, bundled by services/api/Makefile into `index.mjs`
 * (infra/stacks/api.yaml, `ChatFunction`).
 *
 * Everything expensive is created once per execution environment: config, the model profile, the
 * Converse client and the DynamoDB stores. Each request then gets its own tool executor, bound to the
 * authorizer's `claims.sub` (see `lib/chat-turn.ts`).
 *
 * Seams still on stand-ins (wired by #36): the system prompt is `placeholderSystemPrompt` until #16's
 * prompt lands, and no notifier is passed yet: #35's SES notifier exists (`sesNotifierFromEnv` in
 * `@sched/tools/ses`) and #36 wires it. Until then escalations are recorded with notification status
 * FAILED and the patient is given the front-desk number (#23).
 */
import { ConverseLlmClient } from "@sched/agent";
import { SystemClock } from "@sched/tools";

import { createAwsStores } from "../lib/aws";
import { chatConfigFromEnv } from "../lib/config";
import { chatStreamHandler } from "../lib/lambda";
import { consoleLogger } from "../lib/log";
import { placeholderSystemPrompt } from "../lib/system-prompt";

const config = chatConfigFromEnv();
const clock = new SystemClock();
const { repos, turns } = createAwsStores({ tableName: config.tableName, clock });

export const handler = awslambda.streamifyResponse(
  chatStreamHandler({
    repos,
    turns,
    // Interactive chat: the SDK's default 3 attempts (with backoff) are the retry budget.
    llm: new ConverseLlmClient(),
    profile: config.profile,
    clock,
    systemPrompt: placeholderSystemPrompt,
    dailyTurnCap: config.dailyTurnCap,
    log: consoleLogger,
  }),
);
