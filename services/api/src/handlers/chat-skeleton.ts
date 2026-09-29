/**
 * `POST /api/chat`, walking-skeleton version (M1-05, #7). Lambda entry point, bundled by
 * services/api/Makefile into `index.mjs` (infra/stacks/api.yaml).
 *
 * TEMPORARY: this calls Bedrock directly through `AnthropicBedrock` (bedrock-runtime, ADR-002's
 * interim decision) because `LlmClient` in `packages/agent` was being built in parallel (#15).
 * CLAUDE.md says handlers go through `LlmClient`; S3-03 (#17) replaces this file's model call with
 * `runAgentTurn` + `LlmClient`. Do not copy this pattern.
 */
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";

import { chatStreamHandler } from "../skeleton/lambda";

const MODEL_ID = process.env.MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";

// Created once per execution environment and reused across invocations. Credentials come from the
// Lambda role via the default AWS provider chain. The timeout covers the wait for Bedrock's first
// response; the Lambda timeout (api.yaml) bounds the rest of the stream.
const client = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION, maxRetries: 2, timeout: 60_000 });

export const handler = awslambda.streamifyResponse(
  chatStreamHandler({
    openModelStream: ({ system, userText }) =>
      client.messages.create({
        model: MODEL_ID,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: userText }],
        stream: true,
      }),
    log: (entry) => console.info(entry),
  }),
);
