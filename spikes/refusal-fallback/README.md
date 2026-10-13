# Spike: one forced refusal-fallback turn, live (#37)

**Question:** when the production profile refuses, does the agent loop really retry on its `REFUSAL_FALLBACKS` partner, live on Bedrock, with the conversation's history in the request? The loop's unit tests cover the retry with a scripted client, but it had never run live since PR #53.

**How (r1/Q-4 (a) on #37):** `run.ts` runs two turns through `runAgentTurn`, with the in-memory repositories, the `clinic-default` fixture and its synthetic patient Walter Haines, at the fixture's frozen clock.
- Turn 1 runs live on the chosen profile.
- In turn 2, a wrapper `LlmClient` returns `scriptedRefusal()` for the first call and sends every later call to Bedrock through `ConverseLlmClient`.
- "Confirmed" means turn 2 ends `completed`, and every call after the refusal ran on the fallback's model ID.

```bash
AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npx tsx spikes/refusal-fallback/run.ts [--profile sonnet-4.6]
```

It calls Bedrock: about $0.05 for `sonnet-4.6` → `haiku-4.5`.

**Result (2026-10-13, `sonnet-4.6` at effort `high` → `haiku-4.5`):** confirmed. `results/` has the trace.
- Turn 2's refused call is the wrapper's scripted response. Its trace row carries the requested model ID (`sonnet-4.6`), because the loop records the model it asked for.
- The next two calls ran live on `haiku-4.5`, and the turn completed with a `check_availability` call and a reply listing only the slots the tool returned.

Throwaway spike code, with no tests (as with every spike). It informs ADR-002's 2026-10-12 amendment.
