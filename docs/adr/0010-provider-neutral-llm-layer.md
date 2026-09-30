# ADR-010: Provider-neutral LLM layer via Bedrock Converse

- **Status:** Accepted (2026-09-29, spike S-1c)
- **Date:** 2026-09-29
- **Deciders:** Nick Delgado (+ Claude, drafting and measuring)
- **Related:** PRD FR-035, FR-051, NFR-001, NFR-003; ADR-001, ADR-002 (client decision superseded), ADR-007, ADR-008; issues #60, #57

## Context

ADR-002 planned to run the agent on Claude Opus 5 or Sonnet 5, and chose the Anthropic SDK (`AnthropicBedrock` on bedrock-runtime) as the interim client. Since then:

- **AWS denied access** to Opus 5 and Sonnet 5 on this account. OpenAI's proprietary GPT-5.x models on Bedrock show the same zero-quota block.
- A probe on 2026-09-29 sent our real tool definitions through the **Bedrock Converse API**. These models all returned a correct `check_availability` call:
  - Amazon Nova 2 Lite and Nova Pro;
  - OpenAI gpt-oss-120b and gpt-oss-20b;
  - Claude Sonnet 4.6.

The agent loop and its tests were written against Anthropic's Messages API types. As long as that holds, Claude is the only model the evals can compare. ADR-008's model matrix needs models this account can actually call.

## Options considered

1. **Keep `AnthropicBedrock` and add a second client per provider.**
   - Pros: native Claude features, with no translation.
   - Cons: two or three wire formats reach the loop, and history becomes provider-specific. Each provider brings its own SDK, and OpenAI's would need a separate endpoint and key.
2. **Bedrock Converse as the only transport, behind neutral types.** One API covers Claude, Nova, and gpt-oss, and it models tool use, reasoning blocks, cache points, and usage. Model-specific switches go in `additionalModelRequestFields`.
   - Pros: one adapter; IAM, logging, and quotas stay in one place.
   - Cons: we own a translation layer, and a Claude feature Converse doesn't expose would be out of reach.
3. **The direct OpenAI API for GPT models.**
   - Rejected: a second vendor account, a key to manage, and data leaving AWS. None of that is justified for a proof of concept.

## Decision

**Option 2.** Converse is the single LLM transport.

**The neutral message model** (`@sched/contracts` `content.ts`, contracts v1.1):
- Messages are `{ role, content[] }`. Content blocks are:
  - `text`;
  - `tool_use` (`id`, `name`, `input`);
  - `tool_result` (`toolUseId`, JSON `content`, `isError`);
  - `reasoning`.
- **`reasoning` is opaque and tagged** with the producing profile's `family` (`anthropic.claude`, `amazon.nova`, `openai.gpt-oss`) and `modelId`. It carries `text`, a `signature`, or `redactedContent`.
- **The replay rule:** the loop sends a reasoning block back only to a profile with the same `family` that accepts reasoning input. Otherwise it drops the block from the request copy, never from history. History stays append-only (CLAUDE.md rule 4).
- **Requests may carry `cache_point` markers.** The loop places them only where the profile says the model accepts them: after the stable system block, and at the end of the last user message.
- **Stop reasons are normalized** as follows:

  | Converse `stopReason` | Neutral | Loop behaviour |
  |---|---|---|
  | `end_turn`, `stop_sequence` | same | completed |
  | `tool_use` | `tool_use` | run tools, loop |
  | `max_tokens` | `max_tokens` | discard, retry once with a larger budget |
  | `guardrail_intervened`, `content_filtered` | `refusal` | discard, retry once on the fallback profile |
  | `model_context_window_exceeded` | `context_window_exceeded` | new outcome, fixed reply |
  | `malformed_tool_use`, `malformed_model_output` (or non-JSON tool input) | `malformed_output` | discard, retry once, then a new outcome |

  Traces keep the raw value in `providerStopReason`. Usage is normalized to our `TokenUsage`, where `inputTokens` excludes cache reads and writes.

**`LlmClient` speaks only these types.** `ConverseLlmClient` (`@aws-sdk/client-bedrock-runtime`, `ConverseStream`) is the production implementation, and `ScriptedLlmClient` is the test double.

**Model choice stays configuration.** There are six entitled profiles:
- `sonnet-4.6` (default)
- `haiku-4.5`
- `nova-2-lite`
- `nova-pro`
- `gpt-oss-120b`
- `gpt-oss-20b`

`opus-5` and `sonnet-5` stay defined but are marked `entitled: false`, and resolving them throws. Each profile carries:
- its reasoning switch (`modelFields`);
- where it accepts cache points, and its cache minimum;
- whether it replays reasoning, and any inline reasoning tag;
- `maxTokens`, `retryMaxTokens`, and its refusal fallback;
- a price table for cost estimates.

The M3 eval matrix (#37) still chooses the production default.

**OpenAI models are used only through Bedrock.**

## Consequences

- **Parity held, so the `AnthropicBedrock` adapter is retired.**
  - `packages/agent` no longer depends on `@anthropic-ai/*`.
  - The walking-skeleton handler in `services/api` still calls the Anthropic SDK directly. #17 replaces it with `runAgentTurn` + `ConverseLlmClient`.
- **IAM for #17.** Converse is authorized by `bedrock:InvokeModelWithResponseStream` (and `bedrock:InvokeModel`). The chat role needs these resources:
  - the Nova inference-profile ARNs, plus their foundation-model ARNs in the US regions they route to;
  - the gpt-oss foundation-model ARNs;
  - the Claude ARNs it already has.
- **Wire facts learned the hard way** (all encoded in profiles or the adapter, and covered by tests):
  - **Nova** accepts cache points only in `system`. A cache point in `tools`, or after a `toolResult`, is a ValidationException.
  - **gpt-oss rejects any cache point** ("AccessDeniedException: … did not allow prompt caching").
  - **Nova Pro rejects reasoning blocks in history** ("User messages cannot contain reasoning content"). So `replaysReasoning: false`.
  - **Claude validates the signature** on replay. A fake one is rejected.
  - **Inline chain-of-thought in visible text.** Nova Pro writes `<thinking>…</thinking>`, and gpt-oss-120b sometimes writes `<reasoning>…</reasoning>`. The adapter moves a leading tagged section into a reasoning block and never streams it.
  - **gpt-oss sends an empty text block**; the adapter drops it.
  - **Converse sends `contentBlockStart` only for tool calls.** Text and reasoning blocks start at their first delta.
  - **gpt-oss streams only 2–4 text deltas per turn.** The UI's typewriter smoothing (ADR-007) matters more for it.
- **Contracts v1.1 (#57)** came with this change:
  - neutral content blocks;
  - the `text_reset` stream event (ADR-007);
  - `ToolCallTrace.known`, with free-form tool names;
  - `LlmCallTrace.attempt` and `providerStopReason`;
  - the `context_window_exceeded` and `malformed_output` outcomes;
  - neutral tool definitions (`inputSchema`).
- **Not verified live:**
  - a Claude refusal through Converse (we can't trigger one cheaply), so the mapping is from the documented enum;
  - redacted reasoning (none was produced);
  - `malformed_tool_use` (not observed).

  Unit tests cover all three paths.
- **Revisit if:**
  - a Claude feature we need (e.g., server tools or citations) isn't reachable through Converse. In that case, add a second `LlmClient` behind the same neutral types; the loop won't change.
  - Opus 5 or Sonnet 5 become entitled. Then flip `entitled` and run the matrix.

## Validation (spike S-1c, `spikes/s1c-converse/`)

The spike ran the production path (`runAgentTurn` over `ConverseLlmClient`) for N=5 turns per profile. Each turn is question → `check_availability` → answer. It used S-1's production-sized system prompt plus the real contract tool definitions, and was paced to quota. Estimated spend was **$0.16**, including the design probes.

Raw data:
- `spikes/s1c-converse/results/raw-2026-09-30T02-13-28-602Z.json` (all profiles);
- `raw-2026-09-30T02-16-35-566Z.json` (the gpt-oss rerun after the inline-tag fix).

| Profile | Turns OK | Correct tool call | Turn p50 / p95 | TTFT p50 (call A / answer) | Tokens per turn, mean (in / cache read / cache write / out) | Cache read on call B | Text deltas per turn | $ per turn |
|---|---|---|---|---|---|---|---|---|
| sonnet-4.6 | 5/5 | 5/5 | 4.65 s / 6.52 s | 1.13 s / 1.04 s | 4 / 5,767 / 841 / 261 | 5/5 | 33 | 0.0088 |
| haiku-4.5 | 5/5 | 5/5 | 2.51 s / 3.24 s | 0.70 s / 0.73 s | 6,585 / 0 / 0 / 229 | 0/5 (below the 4,096 minimum) | 27 | 0.0077 |
| nova-2-lite | 5/5 | 5/5 | 3.76 s / 6.80 s | 0.58 s / 0.58 s | 858 / 5,084 / 599 / 666 | 5/5 | 26 | 0.0023 |
| nova-pro | 5/5 | 5/5 | 2.35 s / 2.93 s | 0.55 s / 0.60 s | 778 / 4,141 / 1,038 / 187 | 4/5 | 80 | 0.0021 |
| gpt-oss-120b | 5/5 | 3/5 (called `find_providers` first) | 3.19 s / 3.99 s | 0.59 s / 0.60 s | 5,778 / 0 / 0 / 211 | n/a (no caching) | 3 | 0.0010 |
| gpt-oss-20b | 5/5 | 5/5 | 1.57 s / 1.95 s | 0.58 s / 0.59 s | 4,131 / 0 / 0 / 181 | n/a | 3 | 0.0003 |

**Reasoning round-trip.**
- In every Sonnet turn (5/5), adaptive thinking produced a signed reasoning block, and the turn's second call accepted it.
- The signed block, stored in history, was then accepted on the **next turn** by:
  - Sonnet 4.6;
  - Haiku 4.5 (same family, different model);
  - gpt-oss-120b (block dropped from the request).
- Nova 2 Lite's `[REDACTED]` reasoning and gpt-oss's unsigned reasoning were replayed within the turn (5/5 each).

**Caching.**
- Sonnet reads the 3,124-token tools + system prefix on call B of every turn, and on call A of every warm turn. Its uncached input falls to single digits, because the rolling message cache point covers the rest.
- Haiku's prefix is below its 4,096-token minimum, as in S-1.
- Nova caches via the system cache point.

**Parity with the retired client.** S-1 measured Sonnet 4.6 at a 5.16 s / 7.02 s full-turn p50/p95 and $0.0093 per turn through `AnthropicBedrock`. Converse measured 4.65 s / 6.52 s and $0.0088 on the same kind of turn. Haiku was 3.54 s / 4.08 s in S-1 and 2.51 s / 3.24 s here. The tool definitions differ slightly (the fixture versus the contracts), so these are indicative numbers, not a controlled A/B test. No regression.

**Streaming.** Deltas are incremental for Claude and Nova (26–80 per turn). gpt-oss delivers its answer in 2–4 chunks.

**gpt-oss reads `reasoning_effort`.** An invalid value was rejected with "unknown variant `bogus`, expected one of `high`, `low`, `max`, `medium`, `minimal`, `none`, `xhigh`". So the field is validated, not silently ignored.

**Finding fixed during the spike.** In the first run, gpt-oss-120b put `<reasoning>…</reasoning>` in patient-visible text in 2 of 5 turns. After we enabled the inline-tag filter for gpt-oss, the rerun had 0 leaks in 10 turns.

**gpt-oss-120b's two "incorrect" turns** called `find_providers` before `check_availability`. That's a reasonable plan, but the spike's executor answers only `check_availability`, so the model gave up and offered the front desk. This is a trajectory difference for the eval harness to judge (#30), not a transport failure.
