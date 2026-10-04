# ADR-002: Model selection and Bedrock client

- **Status:** Client decision superseded by [ADR-010](0010-provider-neutral-llm-layer.md) (2026-09-29): Bedrock Converse is the single transport, and the `AnthropicBedrock` client is retired. The model-selection method below (profiles as configuration, chosen by the M3 eval matrix) still stands. Interim development path accepted 2026-09-28 (Sonnet 4.6).
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

- **Client:** `AnthropicBedrockMantle` (TypeScript, `@anthropic-ai/bedrock-sdk`), region `us-east-1`, global routing. It sits behind our `LlmClient` interface (ADR-001), so switching to the `bedrock-runtime` path later is a one-file change. *(Superseded by ADR-010: `ConverseLlmClient` on bedrock-runtime.)*
- **Default model:** `anthropic.claude-opus-5`, starting at `effort: "medium"` for chat latency. We tune the setting with evals rather than guessing. *(Superseded by the interim decision below: `sonnet-4.6` is the development default until the M3 matrix, #37.)*
- **The model is configuration.** Environment variable `AGENT_MODEL_PROFILE` selects a `ModelProfile`. The eval harness runs a **model × effort matrix** (Opus 5, Sonnet 5, Haiku 4.5), and the production default is chosen from measured **task success, pass^k reliability, p95 latency, and cost per completed conversation**. That decision gets recorded here when M3 completes. *(Refined by ADR-010 and PRD FR-042 (#123): the matrix runs the six entitled profiles, `sonnet-4.6`, `haiku-4.5`, `nova-2-lite`, `nova-pro`, `gpt-oss-120b`, `gpt-oss-20b`, with effort levels only where a profile has a reasoning switch; Opus 5 and Sonnet 5 aren't entitled and are out of it. The production profile is the cheapest by agent cost per completed conversation that meets every PRD §7 target and NFR-001, with the lower p95 breaking ties; if none qualifies, `sonnet-4.6` stays and the reason is recorded.)*
- **Refusals:** check `stop_reason === "refusal"` before reading content. Retry once on the fallback profile (the next model in the matrix). If that fails, show a safe message and offer escalation.
- **Caching:** tools + system prompt are cached (stable prefix). Check `usage.cache_read_input_tokens` in traces to confirm caching works. *(Refined by ADR-010: `TokenUsage.cacheReadTokens` in traces.)*

## Consequences

- Lambda roles need `bedrock-mantle:CreateInference` scoped to the chosen model resources. The bootstrap permission set needs it for local eval runs. *(Superseded by ADR-010: `bedrock:InvokeModel*` on inference-profile and foundation-model ARNs.)*
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

### Interim results (2026-09-28): partially blocked on account access

The spike uses a production-sized prefix: a draft system prompt plus all 7 tool schemas, about 2.6k tokens. Raw results are in `spikes/s1-bedrock-tool-latency/results/`.

**Access (why most of the matrix couldn't run yet)**

| Model | `get-foundation-model-availability` | Mantle (`AnthropicBedrockMantle`) | bedrock-runtime (`AnthropicBedrock`, US inference profile) |
|---|---|---|---|
| Opus 5 | authorization `AUTHORIZED`, **agreement `NOT_AVAILABLE`** | 403 "not available for this account" | 403 "not available for this account" |
| Sonnet 5 | authorization `AUTHORIZED`, **agreement `NOT_AVAILABLE`** | 403 (same) | 403 (same) |
| Haiku 4.5 | authorization `AUTHORIZED`, agreement `AVAILABLE` | 403 (same) with ID `anthropic.claude-haiku-4-5`; other IDs 404 | ✅ works via `us.anthropic.claude-haiku-4-5-20251001-v1:0` |

- **"ACTIVE" in the model catalog doesn't mean callable.** Opus 5 and Sonnet 5 still need their AWS Marketplace agreement accepted. Bedrock does that on the first call by an identity with Marketplace permissions, and our least-privilege `SchedDeployer` role deliberately has none. The fix is a one-time human step (runbook step 6).
- **Mantle refuses even Haiku**, whose agreement is in place. So Claude in Amazon Bedrock (Mantle) looks like a separate enablement on this account. We'll retest after the agreements are accepted.
- **On-demand runtime model IDs need an inference profile.** The bare catalog ID fails with "on-demand throughput isn't supported"; the `us.` prefix works.

**Haiku 4.5, bedrock-runtime, 7 of 10 turns completed** (the other 3 were throttled; see below)

| Metric | p50 | p95 |
|---|---|---|
| Call A (question → `tool_use`), first block | 1.27 s | 2.17 s |
| Call A total | 1.77 s | 2.86 s |
| Call B (answer), first text | 1.24 s | 2.46 s |
| **Full turn (A + B)** | **3.54 s** | **4.68 s** |

- **Tool use:** 7/7 completed turns called `check_availability` with the correct specialty, date, and time of day. Every answer listed only the slots the tool returned.
- **Tokens and cost:** about 5,366 input and 242 output tokens per turn; about $0.0066 per turn at Anthropic list prices (an estimate; Bedrock billing may differ).
- **Caching: 0 tokens written or read.** This confirms the 4,096-token minimum cacheable prefix for Haiku 4.5. At our prompt size, Haiku will pay full input price on every call. Opus 5 (512 minimum) and Sonnet 5 (1,024) should cache it.

**Throttling:** after about 15 calls in two minutes, Bedrock returned 429 "Too many requests", even with the SDK's retries. New accounts appear to start with low on-demand quotas. A full eval matrix, thousands of calls, will need pacing (now in the spike: `--pace-ms`, 6 retries) and probably a quota increase. `SchedDeployer` can't read Service Quotas yet; a read-only addition is proposed in `infra/bootstrap/sched-deployer-policy.json`.

**IAM (resolved from the Service Authorization Reference):** `bedrock-mantle:CreateInference` targets `arn:aws:bedrock-mantle:<region>:<account>:project/*` and is narrowed to models with the `bedrock-mantle:Model` condition key. On the runtime path, `bedrock:InvokeModel*` applies to the inference-profile and foundation-model ARNs.

**Emerging direction (not yet decided):** if Mantle stays unavailable, switch the default client to bedrock-runtime via `AnthropicBedrock` with US inference profiles. That's the path AWS recommends for new applications, it supports invocation logging, it has the same Messages API surface in the SDK, and the `LlmClient` interface makes the swap one file. Decide after the rerun.

**Update (same day): an account-level entitlement restriction, not an agreement step.** Nick tried to accept the agreements as `sched-admin` (playground and CLI) and got the same `AccessDeniedException ... contact AWS Sales`. According to AWS's knowledge-center guidance, an access-denied message that mentions "contact AWS Sales" means an **account-level entitlement restriction**. IAM, SCPs, and console model access can't fix it; AWS Support has to lift it.

Agreement status across every Anthropic model on the account:
- **Agreement `AVAILABLE`:** Haiku 4.5, Sonnet 4, Sonnet 4.6.
- **`NOT_AVAILABLE`:** every Opus (4.1 → 5.5), every Fable, and Sonnet 4.5 / 5 / 5.5.

**Sonnet 4.6 and Haiku 4.5 are callable today** (bedrock-runtime, US inference profiles). Result, N=10 each, 20/20 turns OK with `--pace-ms 2500` and no 429s:

| Metric | Sonnet 4.6 (adaptive thinking, effort `medium`) | Haiku 4.5 |
|---|---|---|
| Call A first block, p50 / p95 | 1.38 s / 1.61 s | 1.32 s / 1.60 s |
| Call A total, p50 / p95 | 2.67 s / 2.93 s | 1.82 s / 2.12 s |
| Call B (answer) first text, p50 / p95 | 1.44 s / 2.60 s | 1.17 s / 2.23 s |
| **Full turn, p50 / p95** | **5.16 s / 7.02 s** | **3.54 s / 4.08 s** |
| Correct `check_availability` call | 10/10 | 10/10 |
| Tokens per turn (uncached in / cache write / cache read / out) | 1,113 / 214 / 4,070 / 262 | 5,365 / 0 / 0 / 235 |
| **Estimated cost per turn** | **$0.0093** | **$0.0065** |

- **Caching narrows the price gap.** Sonnet 4.6 costs 3× Haiku per token, but only about 1.4× per turn, because it caches the 2,142-token prefix from the second call on. Haiku can't cache it at all (4,096 minimum).
- **An anecdote, not a metric:** Sonnet 4.6's answers followed the prompt's formatting rules more closely (weekday + date on every option, first name, asks for the visit reason). Haiku omitted per-option weekdays and used bold markdown. The eval harness will quantify this.
- Both models meet NFR-001 on this single-tool turn from a laptop. The first streamed text arrives in about 1.2–1.4 s p50, against a target of ≤ 3 s.

**Proposed interim path (awaiting Nick's decision):**
1. Nick opens an AWS Support case to lift the entitlement restriction for Opus 5 and Sonnet 5. First he checks whether the account is on the Free plan; if so, upgrading to the Paid plan may be the fix.
2. Until then, development and the M1 walking skeleton use **bedrock-runtime + Sonnet 4.6** (`us.anthropic.claude-sonnet-4-6`), with Haiku 4.5 as the second profile. Model choice is config (`AGENT_MODEL_PROFILE`), so nothing structural changes.
3. When entitlement arrives, rerun this spike for Opus 5 and Sonnet 5 on both backends, then finalize the client and the default model here.

### Interim decision (accepted by Nick, 2026-09-28)

- **Client:** `AnthropicBedrock` from `@anthropic-ai/bedrock-sdk` (bedrock-runtime), behind the `LlmClient` interface. Mantle is unavailable to this account.
- **Development default profile:** `us.anthropic.claude-sonnet-4-6` (adaptive thinking, effort `medium`). Second profile: `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
- **IAM:** `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` on the US inference-profile ARNs plus the underlying foundation-model ARNs in the US regions they route to.
- **Target models remain Opus 5 and Sonnet 5.** They'll be measured in follow-up issue "S-1b" when AWS lifts the restriction, and the M3 eval matrix (#37) decides the production default. *(Superseded by [ADR-008's 2026-10-03 amendment](0008-evaluation-strategy.md#amendment-2026-10-03-ci-gate-model-matrix-api-surface-case-judge-agreement-123): Opus 5 and Sonnet 5 aren't entitled and are out of the matrix.)*
