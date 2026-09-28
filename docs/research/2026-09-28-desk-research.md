# Desk research — 2026-09-28

Phase 0 research that informed ADR-001…009. Each finding lists its source and the decision it affected. Anything marked **verify in spike** is unconfirmed until we run code against the account.

## 1. Calling Claude on Amazon Bedrock

- **Two endpoints serve the Anthropic Messages API on Bedrock:**
  - `bedrock-mantle.{region}.api.aws/anthropic/v1/messages` ("Claude in Amazon Bedrock").
  - `bedrock-runtime` (`InvokeModel`, or an `/anthropic` route).
  - Anthropic's docs present Mantle via `AnthropicBedrockMantle` for current models. AWS's docs say *"for new applications, we recommend the `bedrock-runtime` endpoint"*, citing AWS SDK integration and invocation logging. → ADR-002 picks Mantle behind an `LlmClient` interface. **Verify in spike S-1** whether invocation logging covers Mantle.
- **Mantle IAM** uses its own action prefix: `bedrock-mantle:CreateInference` (+ `bedrock-mantle:CountTokens`). `bedrock:*` actions don't cover it. → Bootstrap policy and Lambda roles.
- **Model IDs** (Mantle):
  - `anthropic.claude-opus-5`
  - `anthropic.claude-sonnet-5`
  - `anthropic.claude-haiku-4-5`
  - (also `anthropic.claude-opus-5-5` and `anthropic.claude-fable-5-1`)
  - Access: Opus 5 has per-model access criteria (check the console). Sonnet 5 and Haiku 4.5 are open to all Bedrock customers.
- **Routing and pricing:** a global endpoint (no premium) or regional endpoints (+10%). `us-east-1` supports global, US, and in-region.
- **Not supported on Bedrock:** server-side `fallbacks` (use the client-side pattern), Batches, the Files API, and server tools (web search, code execution). Structured outputs are listed as unsupported on Anthropic's page but documented on AWS's. → We don't depend on them.
- **Default quota:** 2M input TPM.

Sources: [Claude in Amazon Bedrock (Anthropic docs)](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock), [Inference using Anthropic Messages API (AWS docs)](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html), [Claude Opus 5 model card (AWS)](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html)

## 2. API Gateway response streaming

- Since **November 2025**, REST APIs support response streaming for Lambda, HTTP proxy, and private integrations:
  - Lambda integration URI `…/functions/<arn>/response-streaming-invocations`, with `responseTransferMode: STREAM`.
  - Integration timeout up to **15 min**; idle timeout 5 min on Regional endpoints and 30 s on edge-optimized.
  - Works with Cognito User Pool authorizers.
  - Not supported: VTL response transforms, integration caching, content encoding.
  - Handlers use `awslambda.streamifyResponse` + `awslambda.HttpResponseStream.from(stream, {statusCode, headers})`.
- HTTP APIs keep a 30 s integration timeout and don't stream. → ADR-007 moves from HTTP API to REST API.

Sources: [AWS What's New, Nov 2025](https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis), [AWS Compute Blog: Building responsive APIs with API Gateway response streaming](https://aws.amazon.com/blogs/compute/building-responsive-apis-with-amazon-api-gateway-response-streaming/)

## 3. Amazon Transcribe Streaming

- **Encodings:** `pcm` (signed 16-bit LE, not WAV), `ogg-opus`, `flac`; 8–48 kHz. PCM is recommended.
- The service is built for **real-time delivery**. Guidance is 50–200 ms chunks at roughly real-time pace. Pre-recorded audio should be rate-limited to real time, and sending it faster can cause signing issues on streams longer than 5 minutes.
- The JS SDK (`@aws-sdk/client-transcribe-streaming`) uses HTTP/2 in Node.js and WebSockets in the browser.
- **Implication:** uploading a finished clip to a Lambda that re-streams it adds latency roughly equal to the clip's length. Streaming from the browser *during* recording avoids that. → ADR-006.
- **Verify in spike S-3:** browser behavior (Safari AudioWorklet, sample rates), and stop-to-final latency.

Sources: [StartStreamTranscription API reference](https://docs.aws.amazon.com/transcribe/latest/APIReference/API_streaming_StartStreamTranscription.html), [Transcribing streaming audio](https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html), [aws-samples/amazon-transcribe-websocket](https://github.com/aws-samples/amazon-transcribe-websocket)

## 4. Lambda runtime

- `nodejs24.x` has been available since November 2025, in all regions; it is LTS, supported until about April 2028. **Callback-style handlers aren't supported**, so handlers must be async. → Runtime choice in ADR-003 and CLAUDE.md.

Source: [AWS Lambda adds support for Node.js 24](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-lambda-nodejs-24)

## 5. Bedrock AgentCore (considered, not chosen)

- AgentCore is a serverless, framework-agnostic agent platform. Its components are Runtime, Gateway, Memory, Identity, Observability, Evaluations, Browser, and Code Interpreter.
- Runtime is billed on active vCPU-hours and GB-hours; CPU is not billed during I/O wait.
- Strong for long-running, stateful, multi-tool production agents. Heavier than our proof-of-concept needs. → Recorded as the "revisit if" path in ADR-001.

Sources: [What is Amazon Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html), [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)

## Open questions carried into spikes

| # | Question | Spike |
|---|---|---|
| Q1 | Opus 5 access status on Nick's account; exact resource ARNs for `bedrock-mantle:CreateInference` | S-1 |
| Q2 | Per-model tool round-trip latency and cost, and cache hit behavior | S-1 |
| Q3 | Does Bedrock model invocation logging capture Mantle calls? | S-1 |
| Q4 | Does streaming pass cleanly through CloudFront → REST API → Lambda, including the Cognito authorizer, from SAM? | S-2 (M1-05) |
| Q5 | Stop-to-final-transcript latency and Safari behavior for browser streaming | S-3 |
