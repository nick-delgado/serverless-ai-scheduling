# Spike S-1: Bedrock tool-use round-trip latency (#9)

Throwaway measurement code that feeds [ADR-002](../../docs/adr/0002-model-and-bedrock-client.md). It is not production code; the real agent loop lives in `packages/agent`.

**What it measures.** One realistic agent turn per run:
1. **Call A:** the patient asks about dermatology openings, and the model should respond with `check_availability`.
2. A canned `tool_result` with three slots.
3. **Call B:** the model writes the answer the patient would see.

For each turn it records:
- time to first block, time to first text, and total, for both calls;
- tokens: input, cache write, cache read, output;
- stop reasons, tool inputs, and an estimated cost.

The prefix is **production-sized**: a draft system prompt plus all 7 v1 tool schemas, about 2.6k tokens (`fixture.ts`). That way cache behaviour and token counts match reality.

```bash
# from the repo root (after npm ci)
cd spikes/s1-bedrock-tool-latency
AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npx tsx run.ts \
  --backend runtime|mantle --models opus-5,sonnet-5,haiku-4.5 --runs 10 --budget 1.5 --pace-ms 2000
```

- `--backend mantle` uses `AnthropicBedrockMantle` (Claude in Amazon Bedrock) with IDs like `anthropic.claude-opus-5`.
- `--backend runtime` uses `AnthropicBedrock` (bedrock-runtime InvokeModel) with US inference profiles like `us.anthropic.claude-opus-5`.
- `--budget` is a hard stop on estimated spend, computed with Anthropic list prices. Bedrock billing may differ.
- Models run round-robin, with `--pace-ms` between calls and SDK retries on 429.

Results are written to `results/raw-<backend>-<timestamp>.json` and `results/summary-<backend>-<timestamp>.md`. Caller ARNs are recorded with the account ID redacted.
