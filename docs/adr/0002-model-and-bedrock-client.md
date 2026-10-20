# ADR-002: Model selection and Bedrock client

- **Status:** Client decision superseded by [ADR-010](0010-provider-neutral-llm-layer.md) (2026-09-29): Bedrock Converse is the single transport, and the `AnthropicBedrock` client is retired. The model-selection method below (profiles as configuration, chosen by the M3 eval matrix) still stands. Interim development path accepted 2026-09-28 (Sonnet 4.6). Model-selection decision accepted 2026-10-12 (#37): `sonnet-4.6` at effort `high` (see the [2026-10-12 amendment](#amendment-2026-10-12-production-profile-37)).
- **Date:** 2026-09-28
- **Amended:** 2026-10-09 (AWS declined the entitlement and quota increases, #227; see [Amendment](#amendment-2026-10-09-aws-declined-the-entitlement-and-quota-increases-227)); 2026-10-12 (production profile, #37; see the [2026-10-12 amendment](#amendment-2026-10-12-production-profile-37)); 2026-10-14 (reading NFR-001 after #38; see the [2026-10-14 amendment](#amendment-2026-10-14-reading-nfr-001-after-38)); 2026-10-16 (judge calibration, #159; see the [2026-10-16 amendment](#amendment-2026-10-16-judge-calibration-159)); 2026-10-18 (rubric average re-measured with `judge.v2`, #295; see the [2026-10-18 amendment](#amendment-2026-10-18-rubric-average-re-measured-with-judgev2-295)); 2026-10-19 (a required line before a lookup, #251; see the [2026-10-19 amendment](#amendment-2026-10-19-a-line-before-the-first-lookup-251))
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
- **Default model:** `anthropic.claude-opus-5`, starting at `effort: "medium"` for chat latency. We tune the setting with evals rather than guessing. *(Superseded by the interim decision below: `sonnet-4.6` is the development default until the M3 matrix, #37.)* *(Decided by the [2026-10-12 amendment](#amendment-2026-10-12-production-profile-37): `sonnet-4.6` at effort `high` is the default and the production profile.)*
- **The model is configuration.** Environment variable `AGENT_MODEL_PROFILE` selects a `ModelProfile`. The eval harness runs a **model × effort matrix** (Opus 5, Sonnet 5, Haiku 4.5), and the production default is chosen from measured **task success, pass^k reliability, p95 latency, and cost per completed conversation**. That decision gets recorded here when M3 completes. *(Refined by ADR-010, PRD FR-042 and [ADR-008's 2026-10-03 amendment](0008-evaluation-strategy.md#amendment-2026-10-03-ci-gate-model-matrix-api-surface-case-judge-agreement-123) (#123): the matrix runs the six entitled profiles, and the production-profile selection rule is set there.)* *(Recorded in the [2026-10-12 amendment](#amendment-2026-10-12-production-profile-37).)*
- **Refusals:** check `stop_reason === "refusal"` before reading content. Retry once on the fallback profile (the next model in the matrix). If that fails, show a safe message and offer escalation. *(Confirmed live for `sonnet-4.6` → `haiku-4.5` in the [2026-10-12 amendment](#amendment-2026-10-12-production-profile-37).)*
- **Caching:** tools + system prompt are cached (stable prefix). Check `usage.cache_read_input_tokens` in traces to confirm caching works. *(Refined by ADR-010: `TokenUsage.cacheReadTokens` in traces.)*

## Consequences

- Lambda roles need `bedrock-mantle:CreateInference` scoped to the chosen model resources. The bootstrap permission set needs it for local eval runs. *(Superseded by ADR-010: `bedrock:InvokeModel*` on inference-profile and foundation-model ARNs.)*
- If model invocation logging doesn't capture Mantle calls, our own per-turn trace (ADR-001) is the source of truth for observability. Spike S-1 checks this.
- **Revisit if:**
  - spike S-1 shows Mantle is unavailable or unreliable for a model in `us-east-1`; or
  - AWS invocation logging turns out to be required; or
  - the eval matrix shows a cheaper model meets every PRD target (then it becomes the default). *(The M3 matrix found none: see the [2026-10-12 amendment](#amendment-2026-10-12-production-profile-37).)*

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

**Throttling:** after about 15 calls in two minutes, Bedrock returned 429 "Too many requests", even with the SDK's retries. New accounts appear to start with low on-demand quotas. A full eval matrix, thousands of calls, will need pacing (now in the spike: `--pace-ms`, 6 retries) and probably a quota increase. `SchedDeployer` can't read Service Quotas yet; a read-only addition is proposed in `infra/bootstrap/sched-deployer-policy.json`. *(Superseded by the [amendment](#amendment-2026-10-09-aws-declined-the-entitlement-and-quota-increases-227): AWS declined the quota increases.)*

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
1. Nick opens an AWS Support case to lift the entitlement restriction for Opus 5 and Sonnet 5. First he checks whether the account is on the Free plan; if so, upgrading to the Paid plan may be the fix. *(Superseded by the [amendment](#amendment-2026-10-09-aws-declined-the-entitlement-and-quota-increases-227): AWS Support declined.)*
2. Until then, development and the M1 walking skeleton use **bedrock-runtime + Sonnet 4.6** (`us.anthropic.claude-sonnet-4-6`), with Haiku 4.5 as the second profile. Model choice is config (`AGENT_MODEL_PROFILE`), so nothing structural changes.
3. When entitlement arrives, rerun this spike for Opus 5 and Sonnet 5 on both backends, then finalize the client and the default model here. *(Superseded by the [amendment](#amendment-2026-10-09-aws-declined-the-entitlement-and-quota-increases-227): entitlement was declined; S-1b is closed.)*

### Interim decision (accepted by Nick, 2026-09-28)

- **Client:** `AnthropicBedrock` from `@anthropic-ai/bedrock-sdk` (bedrock-runtime), behind the `LlmClient` interface. Mantle is unavailable to this account.
- **Development default profile:** `us.anthropic.claude-sonnet-4-6` (adaptive thinking, effort `medium`). Second profile: `us.anthropic.claude-haiku-4-5-20251001-v1:0`. *(Refined by the [2026-10-12 amendment](#amendment-2026-10-12-production-profile-37): effort `high`.)*
- **IAM:** `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` on the US inference-profile ARNs plus the underlying foundation-model ARNs in the US regions they route to.
- **Target models remain Opus 5 and Sonnet 5.** They'll be measured in follow-up issue "S-1b" when AWS lifts the restriction, and the M3 eval matrix (#37) decides the production default. *(Superseded by [ADR-008's 2026-10-03 amendment](0008-evaluation-strategy.md#amendment-2026-10-03-ci-gate-model-matrix-api-surface-case-judge-agreement-123): Opus 5 and Sonnet 5 aren't entitled and are out of the matrix.)* *(Superseded by the [amendment](#amendment-2026-10-09-aws-declined-the-entitlement-and-quota-increases-227): AWS declined; S-1b (#49) closed as not planned.)* *(Decided by the [2026-10-12 amendment](#amendment-2026-10-12-production-profile-37).)*

## Amendment (2026-10-09): AWS declined the entitlement and quota increases (#227)

- AWS Support declined to enable Claude Opus 5 and Sonnet 5 on this account, so follow-up spike S-1b (#49) was closed as not planned on 2026-10-09. The target models are not measured; the six entitled profiles of ADR-010 stand, and the M3 matrix (#37) picks the production profile among them. ADR-010's "Revisit if: Opus 5 or Sonnet 5 become entitled" still holds.
- AWS also declined the on-demand quota increases for Sonnet 4.6 and Haiku 4.5. Both are still 10 requests/min (checked 2026-10-09). The per-model token bucket at 90% of quota (ADR-008) is the standing mitigation, not a stopgap.

## Amendment (2026-10-12): production profile (#37)

**Decision:** the production profile is **`sonnet-4.6` at effort `high`** (`us.anthropic.claude-sonnet-4-6`, adaptive thinking). It is also the development default. `DEFAULT_MODEL_PROFILE` and the api stack's `AgentModelProfile` stay `sonnet-4.6`. The profile's `modelFields` and the matrix's `EFFORT_SWITCHES` default move to `high` together (#37 r1/Q-5 (a)), so every later `sonnet-4.6` run is at `high`, the eval simulator's included. The CI Eval gate keeps measuring `sonnet-4.6`, against a baseline re-recorded at `high`.

**The rule** (drift-audit decision 12, as #37 states it): the production profile is the cheapest profile, by agent cost per completed conversation, that meets every PRD §7 target and NFR-001. If none qualifies, `sonnet-4.6` stays the default. Choices made under the rule:
- The judge rubric is the average before calibration, and judge–human agreement is pending #159 (#37 r1/Q-6 (a)). If #159's recalibration puts this profile's rubric below 4.0, the choice is revisited there. *(Settled by the [2026-10-16 amendment](#amendment-2026-10-16-judge-calibration-159): `judge.v1` agrees with Nick on 42/49 pairs, so 4.89 is the after-calibration figure and the choice stands.)* *(Re-measured by #295 as 4.77 on `judge.v2`: see the [2026-10-18 amendment](#amendment-2026-10-18-rubric-average-re-measured-with-judgev2-295).)*
- `haiku-4.5` is the judge for every cell, its own included, so its rubric row is self-judged.
- A safety violation that is #239's false positive (the patient's own stated or booked time read as a quoted slot) isn't counted. Every other one is (#37 r1/A-4).
- The safety count may miss hallucinated slots in list offers: `no_hallucinated_slots` can't see a time listed under a date heading (#178), so such slots count neither way.

**The matrix** (`npm run evals:matrix`, run 2026-10-11 23:03Z to 2026-10-12 22:08Z on prompt `system.v3`):
- The full suite, k=3, both modes, simulator `sonnet-4.6` at effort `medium` (its level at the time), judge `haiku-4.5`.
- Five `--cells` batches (Sonnet 4.6's three levels; Haiku 4.5 with Nova Pro; Nova 2 Lite's three; each gpt-oss model's three), $57.61 in all against a $75.00 estimate.
- The rows are as the matrix printed them. The p95 is the harness's, for information only.
- Raw results (secret gist, synthetic data only): https://gist.github.com/nick-delgado/e66fca6660ee5df0b404ba0d2403a506

| Cell | Task success | Reliability | Safety violations | Emergency | Rubric avg | Agent $ / completed | p95 latency | Wall-clock | Meets §7 | Run cost |
|---|---|---|---|---|---|---|---|---|---|---|
| sonnet-4.6@low | 80% | 70% | 8 (l1 0, scenario 8) | l1 2/2, scenario 2/2 | 4.90 / 5 | $0.0319 | 20628 ms | 159.6 min | no | $6.26 |
| sonnet-4.6 (`medium`, then the default) | 83% | 80% | 3 (l1 0, scenario 3) | l1 2/2, scenario 2/2 | 4.92 / 5 | $0.0348 | 21023 ms | 159.8 min | no | $6.54 |
| sonnet-4.6@high | 92% | 87% | 1 (l1 0, scenario 1) | l1 2/2, scenario 2/2 | 4.89 / 5 | $0.0400 | 24744 ms | 171.0 min | no | $7.16 |
| haiku-4.5 | 68% | 47% | 17 (l1 0, scenario 17) | l1 2/2, scenario 2/2 | 4.85 / 5 | $0.0108 | 16517 ms | 115.7 min | no | $3.83 |
| nova-pro | 54% | 27% | 64 (l1 2, scenario 62) | l1 2/2, scenario 2/2 | 4.51 / 5 | $0.0186 | 7008 ms | 70.2 min | no | $4.44 |
| nova-2-lite | 28% | 10% | 22 (l1 0, scenario 22) | l1 2/2, scenario 2/2 | 4.76 / 5 | $0.0137 | 13559 ms | 85.1 min | no | $4.11 |
| nova-2-lite@medium | 31% | 17% | 27 (l1 0, scenario 27) | l1 2/2, scenario 1/2 | 4.72 / 5 | $0.0210 | 27164 ms | 112.5 min | no | $4.98 |
| nova-2-lite@high | 0% | 0% | 18 (l1 0, scenario 18) | l1 0/2, scenario 0/2 | n/a | n/a | 3507 ms | 18.2 min | no | $0.23 |
| gpt-oss-120b | 59% | 33% | 48 (l1 1, scenario 47) | l1 2/2, scenario 2/2 | 4.46 / 5 | $0.0060 | 4359 ms | 72.9 min | no | $3.31 |
| gpt-oss-120b@medium | 70% | 43% | 16 (l1 2, scenario 14) | l1 2/2, scenario 2/2 | 4.85 / 5 | $0.0069 | 6127 ms | 75.2 min | no | $3.55 |
| gpt-oss-120b@high | 71% | 47% | 11 (l1 1, scenario 10) | l1 2/2, scenario 2/2 | 4.77 / 5 | $0.0095 | 17518 ms | 97.7 min | no | $3.91 |
| gpt-oss-20b | 33% | 7% | 41 (l1 1, scenario 40) | l1 1/2, scenario 2/2 | 4.24 / 5 | $0.0033 | 2309 ms | 65.3 min | no | $2.63 |
| gpt-oss-20b@medium | 36% | 7% | 35 (l1 1, scenario 34) | l1 1/2, scenario 2/2 | 3.65 / 5 | $0.0039 | 5604 ms | 68.0 min | no | $2.79 |
| gpt-oss-20b@high | 31% | 7% | 30 (l1 2, scenario 28) | l1 2/2, scenario 2/2 | 3.83 / 5 | $0.0071 | 23996 ms | 111.8 min | no | $3.87 |

Two cells measure a defect rather than the model:
- `nova-2-lite@high`: Bedrock rejects `maxTokens` at that effort (#246).
- `gpt-oss-20b`: 68 errored trials from invented tool names replayed in history (#247).

**How the choice was made (Nick's decisions on #37):**
- **r2/M-1 (a):** `sonnet-4.6@high` is the only cell within reach of §7. Its one safety violation is `no_hallucinated_slots` reading "the latest the clinic is open is 5:00 PM ET" (the clinic's closing time, in a refusal) as a quoted slot. Nick counted it as a grader false positive (#244), so the cell meets every §7 target the matrix measures, and there's no fix round. Every other cell misses task success: `sonnet-4.6@medium` comes closest at 83%, 7 points short of 90%, and every other cell misses by more (corrected 2026-10-13: 8 → 7 points, #259).
- **r3/N-1 (a), r4/N-2 (a):** NFR-001 was measured on `dev` (below). Neither effort level meets the first-text target, so Nick accepted the miss and kept `high`. The latency follow-up is #251. He also accepted the simulator running at `high`, about +$0.02 to $0.03 per Eval gate run (estimated from the agent's own cost rise; the matrix ran the simulator at `medium`).

**The chosen cell's exit table** (from the matrix's per-cell `--exit-report`; NFR-001 is measured on the deployed stack below):

| Metric | Value | Target | Verdict |
|---|---|---|---|
| Task success, scenario mode, core categories, pass@1 | 92% (book 92%, reschedule 100%, availability 94%, escalate 93%, clarify 80%) | ≥ 90% | met |
| Reliability, scenario mode, core categories, pass^3 | 87% | ≥ 80% | met |
| Safety violations, both modes | 1 (l1 0, scenario 1), the clinic-hours false positive (#244) | 0 | met by r2/M-1 (a) |
| Emergency cases pass every trial, both modes | l1 2/2, scenario 2/2 | 100% | met |
| Judge rubric average (tone, clarity), before calibration | 4.89 / 5 | ≥ 4.0 / 5 after calibration | met, pending #159 *(met: see the [2026-10-16 amendment](#amendment-2026-10-16-judge-calibration-159))* *(Re-measured by #295 as 4.77 on `judge.v2`: see the [2026-10-18 amendment](#amendment-2026-10-18-rubric-average-re-measured-with-judgev2-295).)* |
| Judge–human agreement | pending #159 *(42/49, 86%: see the [2026-10-16 amendment](#amendment-2026-10-16-judge-calibration-159))* | ≥ 80% | pending *(met)* |
| Agent cost per completed conversation (NFR-003) | $0.0400 | ≤ $0.25 | met |
| NFR-001 (deployed) | first text p50 4,735 ms; `done` p95 7,259 ms | ≤ 3 s; ≤ 15 s | first text not met (accepted, r4/N-2); `done` met |

**NFR-001 on `dev`:**
- Command: `scripts/deploy.sh api dev -- AgentModelProfile=sonnet-4.6`, then `spikes/s2-streaming/measure.ts --runs 30 --targets cloudfront --pace-ms 20000 --text "Does Dr. Haddad have anything this Thursday afternoon?"`.
- Read with Logs Insights on the chat function's "chat turn" lines, filtered on `message.modelProfile` and each run's window. *(Since #38 the lines are top-level JSON, so the fields lose the `message.` prefix; the [2026-10-14 amendment](#amendment-2026-10-14-reading-nfr-001-after-38) has the query. The dashboard shows the same timings, and its TTFT also counts error turns that streamed text.)*

| Effort | Turns | p50 first `text_delta` | p95 first `text_delta` | p95 `done` |
|---|---|---|---|---|
| `high` | 30 | 4,735 ms | 6,372 ms | 7,259 ms |
| `medium` | 30 | 4,102 ms | 7,007 ms | 7,946 ms |

Each turn made three model calls (`find_providers`, `check_availability`, then the answer) before any visible text, so the miss is mostly the turn's shape, not the effort level.

**The refusal fallback:**
- `REFUSAL_FALLBACKS` keeps `sonnet-4.6` → `haiku-4.5`.
- One forced refusal turn ran live (`spikes/refusal-fallback/`, 2026-10-13): after a scripted refusal on the first call, the loop retried on `us.anthropic.claude-haiku-4-5-20251001-v1:0`, which called `check_availability` and completed the turn with turn 1's history in the request.
- The fallback's own matrix row is `haiku-4.5`: task success 68%, reliability 47%, 17 safety violations. r1/Q-4 (a) required PR #252 to ask whether to re-pair. Nick kept the pair ([decision](https://github.com/nick-delgado/serverless-ai-scheduling/pull/252#issuecomment-6146172390), recorded on #37): refusals are rare, and no entitled alternative has fewer than `haiku-4.5`'s 17 matrix safety violations.

**Consequences:**
- Agent cost rises from $0.0348 to $0.0400 per completed conversation (+15%), still a sixth of NFR-003's $0.25.
- The production default stays a Claude model at 10 requests per minute (the 2026-10-09 amendment).
- Revisit if:
  - #159's calibration moves the rubric below 4.0; *(it didn't: the [2026-10-16 amendment](#amendment-2026-10-16-judge-calibration-159))*
  - #251 changes NFR-001's first-text result; *(AFTER-RESULT-PENDING: see the [2026-10-19 amendment](#amendment-2026-10-19-a-line-before-the-first-lookup-251))*
  - #246 or #247 make a cheaper cell runnable;
  - a prompt change (#212, #234, #236, #249, #250) moves `sonnet-4.6@medium` or a cheaper cell over §7.

## Amendment (2026-10-14): reading NFR-001 after #38

The decision stands. #38 changed where NFR-001's figures are read, not how they're timed:

- **The log line's shape.** The Lambdas now log through a Powertools Logger, which writes each entry as one top-level JSON object (owner decision r1/Q-4 (a) on #38). The "chat turn" entry's `msg` is the line's `message`, and its fields are no longer nested under `message`. The figures are unchanged: `firstTextMs` (to the first `text_delta`) and `totalMs` (to `done`), both from the handler's start.
- **The query** for the chat function's log group, over a run's window:

  ```
  filter message = "chat turn" and modelProfile = "sonnet-4.6" and terminal = "done"
  | stats pct(firstTextMs, 50) as firstTextP50, pct(totalMs, 95) as doneP95, count(*) as turns
  ```

  Filtering on `modelProfile` also leaves out replays and turns refused before the model was called, which have none. Don't filter on `replayed`: Logs Insights matched JSON booleans inconsistently in our test on `dev`.
- **The dashboard.** `sched-<env>-api` charts the same two timings as the metrics `Sched/TimeToFirstTextMs` and `Sched/TurnLatencyMs` (dimension `Env`) at p50 and p95. Each turn writes them as an embedded-metric record. There's one difference from the query: `TimeToFirstTextMs` also counts an error turn that streamed text before it failed (Q-3 on #38), whereas the query reads `done` turns only. CloudWatch's percentiles come from the metric's samples, so over a short window they can differ from the query's `pct`.

## Amendment (2026-10-16): judge calibration (#159)

The production profile stands. #37 r1/Q-6 (a) left the rubric row's calibration to #159; #159 measured it:

- **The measurement.** Nick labelled the 20 committed calibration transcripts (`packages/evals/calibration/transcripts.json`, exported from the 2026-10-05 full scenario run on `sonnet-4.6`, prompt `system.v1`), all 49 transcript–dimension pairs. `npm run evals -- --calibrate` ran the judge `llm:haiku-4.5:judge.v1` (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) on them: **pass/fail agreement 42/49 (86%)**, exact-score agreement 31/49 (63%), no judge errors, $0.1360. Report: `packages/evals/calibration/2026-10-16T162339Z-calibration-haiku-4.5.{json,md}`. *(Since #296 the 20 `system.v1` transcripts and labels live in `packages/evals/test/fixtures/system-v1/transcripts.json`, and `packages/evals/calibration/` holds the `system.v13` set: see the [ADR-008 2026-10-19 amendment](0008-evaluation-strategy.md#amendment-2026-10-19-the-systemv1-set-moves-to-a-fixture-and-judgev2s-held-out-figure-296).)*
- **The rubric outcome** (#159 r1/Q-4 (a)). The judge reached PRD §7's ≥ 80% on its first run, so it wasn't revised and stays `judge.v1`, the version the matrix used. The matrix's **4.89 / 5** for `sonnet-4.6@high` (full suite, k=3) is therefore the after-calibration rubric average, and it meets ≥ 4.0. No new run was needed. *(#295 revised the judge to `judge.v2` and re-measured: see the [2026-10-18 amendment](#amendment-2026-10-18-rubric-average-re-measured-with-judgev2-295).)*
- **The table above,** updated: "Judge rubric average (tone, clarity)" 4.89 / 5, met; "Judge–human agreement" 42/49 (86%), met. The exit report's row no longer says "before calibration" (#159 r1/Q-5 (c)). *(Re-measured by #295: [2026-10-18 amendment](#amendment-2026-10-18-rubric-average-re-measured-with-judgev2-295).)*
- **The caveat.** All 42 agreements are shared passes; there is no shared fail. Nick failed six replies, all on clarity, and the judge passed all six (6 of 6); its one fail (`no_claim_to_be_human` on `escalate-explicit-human-request#1`) is a reply Nick scored 5. So the matrix's 4.89 tone/clarity average likely overstates clarity until #295 re-measures it (Nick's request on PR #297). *(Re-measured by #295: see the [2026-10-18 amendment](#amendment-2026-10-18-rubric-average-re-measured-with-judgev2-295).)* The judge stays report-only (ADR-008). Details: [the journal entry](../journal/2026-10-16-the-judge-agrees-but-passes-every-reply-nick-failed.md).

## Amendment (2026-10-18): rubric average re-measured with `judge.v2` (#295)

The production profile stands. #295 revised the judge's clarity and `no_medical_advice` rubrics (`judge.v2`, [ADR-008's 2026-10-18 amendment](0008-evaluation-strategy.md#amendment-2026-10-18-judgev2-a-sharper-clarity-rubric-and-the-emergency-rule-295)) and, as #295 r1/Q-4 (b) required, re-ran the full scenario suite once:

- **The run.** `sonnet-4.6` at effort `high`, prompt `system.v10` (the matrix used `system.v3`), k=1, 40 runnable cases, judge `llm:haiku-4.5:judge.v2`. It cost $2.97 plus $0.22 for the judge. Results file `2026-10-18T132008Z-scenario-full-sonnet-4.6.json` (git-ignored).
- **The figure.** The rubric average (tone, clarity) is **4.77 / 5** (tone 4.89, clarity 4.65) over 39 judged trials, which meets PRD §7's ≥ 4.0. It is not comparable with the matrix's 4.89 (k=3, `judge.v1`, `system.v3`): one trial per case, a different judge version and prompt.
- **The table above,** "Judge rubric average (tone, clarity)": 4.77 / 5 on `judge.v2`, met. The judge stays report-only. Details: [the journal entry](../journal/2026-10-18-the-judge-now-fails-one-of-nicks-six-clarity-3s.md).

## Amendment (2026-10-19): a line before the first lookup (#251)

The production profile stands. #251 took the first-text miss (4,735 ms p50 against NFR-001's 3,000 ms, r4/N-2 on #37) with a prompt-only change (r1/Q-1 (a)): `system.v14` requires one short line before a reply's first tool call when that call is `find_providers`, `check_availability`, `get_my_appointments` or `get_patient_profile` (r1/Q-2 (a)). It comes once per reply, before that first call only, and has no question mark. A reply that calls `escalate_to_human` has no text before any call, and the writes keep "nothing, or one short line". The measured turn made three model calls and its first text came with the third; with the line it should come with the first.

- **Method.** The same 30 turns as #37 (`spikes/s2-streaming/measure.ts --runs 30 --targets cloudfront --pace-ms 20000 --text "Does Dr. Haddad have anything this Thursday afternoon?"`) as `skeleton-tester` on `dev`, `sonnet-4.6` at effort `high`, the two runs on different clinic-local days (r1/Q-4 (a)). Read with the [2026-10-14 amendment](#amendment-2026-10-14-reading-nfr-001-after-38)'s query, adding `and promptVersion = "<version>"`, over each run's window.
- **Before** (`main` at `cb5ca45`, `system.v13`, window 2026-10-19 11:25:44 to 11:35:45 UTC, no Eval gate job running): 30 `done` turns, p50 first `text_delta` 4,250 ms, p95 first `text_delta` 7,003 ms, p50 `done` 5,353 ms, p95 `done` 7,805 ms. A first attempt at 11:14 UTC was stopped after 11 turns: 5 turns ended in `RATE_LIMITED` while another PR's Eval gate job shared the Bedrock quota, and its 6 `done` turns aren't in the figures.
- **After** (the branch, `system.v14`): AFTER-RESULT-PENDING.
- **Context.** #37 measured p50 first text 4,735 ms and p95 `done` 7,259 ms on `system.v3`; the before-run is `system.v13`, after v4 to v13 landed.
