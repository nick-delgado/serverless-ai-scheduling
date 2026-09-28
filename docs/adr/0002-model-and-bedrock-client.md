# ADR-002: Model selection and Bedrock client

- **Status:** Proposed. Pending spike S-1; model choice is finalized after the M3 eval matrix.
- **Date:** 2026-09-28
- **Deciders:** Nick Delgado (+ Claude, drafting)
- **Related:** ADR-001, ADR-008, research note `docs/research/2026-09-28-desk-research.md`

## Context

The agent runs on Claude via Amazon Bedrock. Two questions:
1. **Which endpoint/client** do we call Claude through?
2. **Which model**, given that the chat is latency-sensitive but correctness matters: booking the wrong slot is a real failure?

Desk research (2026-09-28) found two ways to call Claude's Messages API on Bedrock:

| Endpoint | Client | Auth / IAM | Notes |
|---|---|---|---|
| `bedrock-mantle.{region}.api.aws/anthropic/v1/messages` ("Claude in Amazon Bedrock") | `AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk` | SigV4 from the Lambda role; IAM action **`bedrock-mantle:CreateInference`** (+ `bedrock-mantle:CountTokens`). `bedrock:*` actions do **not** cover it. | Anthropic's recommended path for current models. Native Messages API shape, standard SSE streaming. Model IDs `anthropic.claude-*`. |
| `bedrock-runtime.{region}.amazonaws.com` (`InvokeModel` / `/anthropic` route) | AWS SDK `InvokeModel*`, or the Anthropic SDK with a bearer token | `bedrock:InvokeModel*` | AWS's docs recommend it for new applications because of AWS SDK integration and **model invocation logging**. |

Feature notes for Bedrock:
- Supported: prompt caching, tool use, and thinking/effort.
- Not supported: **server-side `fallbacks`** (use a client-side fallback), Message Batches, the Files API, and server tools.
- Structured-output support is documented inconsistently between the Anthropic and AWS docs. We **don't depend on it**; tool schemas plus Zod validation cover our needs.

Endpoint types:
- A **global** endpoint with no price premium.
- **Regional** endpoints with a 10% premium.
- `us-east-1` supports global, US, and in-region routing.

## Options considered (models)

| Model | Bedrock ID | Why consider it |
|---|---|---|
| Claude Opus 5 | `anthropic.claude-opus-5` | Most capable of the three for agentic, multi-step tool use. Adaptive thinking on by default. Latency and cost are highest. |
| Claude Sonnet 5 | `anthropic.claude-sonnet-5` | Near-Opus agentic quality at lower cost and latency. |
| Claude Haiku 4.5 | `anthropic.claude-haiku-4-5` | Fastest and cheapest. Needs to prove it handles multi-step booking reliably. |

Per-model parameter differences are captured in a `ModelProfile` so the loop code doesn't branch on model names:
- Opus 5 and Sonnet 5 take `output_config.effort` with adaptive thinking.
- Haiku 4.5 takes no `effort`. Thinking there uses `budget_tokens`, or is off.

## Decision

- **Client:** `AnthropicBedrockMantle` (TypeScript, `@anthropic-ai/bedrock-sdk`), region `us-east-1`, global routing. It sits behind our `LlmClient` interface (ADR-001), so switching to the `bedrock-runtime` path later is a one-file change.
- **Default model:** `anthropic.claude-opus-5`, starting at `effort: "medium"` for chat latency. We tune the setting with evals rather than guessing.
- **The model is configuration.** Environment variable `AGENT_MODEL_PROFILE` selects a `ModelProfile`. The eval harness runs a **model × effort matrix** (Opus 5, Sonnet 5, Haiku 4.5), and the production default is chosen from measured **task success, pass^k reliability, p95 latency, and cost per completed conversation**. That decision gets recorded here when M3 completes.
- **Refusals:** check `stop_reason === "refusal"` before reading content. Retry once on the fallback profile (the next model in the matrix). If that fails, show a safe message and offer escalation.
- **Caching:** tools + system prompt are cached (stable prefix). Check `usage.cache_read_input_tokens` in traces to confirm caching works.

## Consequences

- Lambda roles need `bedrock-mantle:CreateInference` scoped to the chosen model resources. The bootstrap permission set needs it for local eval runs.
- If model invocation logging doesn't capture Mantle calls, our own per-turn trace (ADR-001) is the source of truth for observability. Spike S-1 checks this.
- **Revisit if:**
  - spike S-1 shows Mantle is unavailable or unreliable for a model in `us-east-1`; or
  - AWS invocation logging turns out to be required; or
  - the eval matrix shows a cheaper model meets every PRD target (then it becomes the default).

## Validation (spike S-1, `spikes/s1-bedrock-tool-latency/`)

1. Call each model with one tool defined and force a tool-use round-trip. Record time to first token, full-turn latency, and tokens, over N=10 runs per model.
2. Confirm the exact IAM actions and resource ARNs, the model access status (Opus 5 has per-model access criteria), and whether prompt-cache reads show up on the second call.
3. Check whether Mantle calls appear in Bedrock model invocation logging.
4. Record the results in this ADR and in a journal entry.
