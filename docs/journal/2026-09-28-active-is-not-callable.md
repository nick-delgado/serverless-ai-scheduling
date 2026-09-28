# 2026-09-28 — "ACTIVE" in the model catalog doesn't mean you can call it

**Chapter:** 3. The walking skeleton
**Milestone:** M1
**Related:** #9 (spike S-1), ADR-002, runbook step 6

## What happened

Spike S-1 was supposed to be the easy one: call three Claude models on Bedrock, time a tool-use round-trip, compare. The setup looked done. The runbook had been followed, `list-foundation-models` showed Opus 5, Sonnet 5, and Haiku 4.5 as `ACTIVE`, and the least-privilege `SchedDeployer` role signed requests fine.

The first run returned three 403s: *"anthropic.claude-opus-5 is not available for this account."* The same for Sonnet 5 and Haiku 4.5.

We went through the layers one at a time instead of guessing:

1. **Not IAM.** The error is a model-access `permission_error`, not an IAM `AccessDenied`, and the signed identity was correct.
2. **Not the model ID.** On the Mantle endpoint, `anthropic.claude-haiku-4-5` is the recognised ID; every other variant returned 404 "does not exist".
3. **The agreement.** `get-foundation-model-availability` showed the real state:
   - Opus 5 and Sonnet 5: `authorizationStatus: AUTHORIZED` (the use-case form was fine), but **`agreementAvailability: NOT_AVAILABLE`**. Their AWS Marketplace agreement was never accepted.
   - Haiku 4.5: agreement `AVAILABLE`.
4. **The endpoint.** Haiku worked on the classic `bedrock-runtime` path (via the `us.` inference profile), but Mantle still refused it. So Mantle access looks like its own switch on this account.

## Why it happened

Bedrock accepts a model's Marketplace agreement on its first call, but only if the caller has AWS Marketplace permissions. We built `SchedDeployer` so that agents *can't* touch billing or Marketplace. That's the right call, and it means the first-call acceptance quietly can't happen. Least privilege worked as designed, but the runbook never mentioned the step it blocked.

## What surprised us

- **"ACTIVE" is a catalog status, not an entitlement.** The only API that told the truth was `get-foundation-model-availability`, which is now in the runbook as a verification step.
- **A new account gets throttled almost immediately.** Once Haiku worked, we hit 429s after about 15 calls in two minutes, even with SDK retries. That's fine for a spike, but the eval harness will make thousands of calls. Quotas are now a tracked risk, and the spike paces itself.
- **Haiku won't cache our prompt.** The production-sized prefix is about 2.6k tokens, and Haiku 4.5's minimum cacheable prefix is 4,096. We saw 0 cache writes and 0 reads, exactly as predicted. So Haiku's "cheap" price is paid on the full prompt every call, while Opus 5 and Sonnet 5 should cache it.

## Evidence

- Haiku 4.5 on bedrock-runtime, 7/10 turns completed before throttling:
  - full turn p50 **3.54 s**, p95 **4.68 s**;
  - answer's first text p50 1.24 s;
  - 7/7 turns called `check_availability` with the correct arguments;
  - about $0.0066 per turn.
- Raw data: `spikes/s1-bedrock-tool-latency/results/`.
- Access table and IAM ARN format: ADR-002, "Interim results".

## What's next

- Nick accepts the Opus 5 and Sonnet 5 agreements as admin (runbook step 6.3) and checks the quotas (step 6.5).
- Rerun the matrix on both backends. If Mantle stays closed, ADR-002 likely moves to `bedrock-runtime`, which AWS already recommends for new applications. Because of the `LlmClient` interface, that's a one-file change.
