# Spike S-1c: the provider-neutral LLM layer, live (#60)

Throwaway measurement code that feeds [ADR-010](../../docs/adr/0010-provider-neutral-llm-layer.md). Unlike S-1, it doesn't call a model directly: it runs the **production code path**, `runAgentTurn` from `packages/agent` over `ConverseLlmClient`, so what it measures is what the chat handler will ship.

**One turn:**
1. The patient asks for dermatology openings (S-1's production-sized system prompt, plus the real contract tool definitions).
2. The model calls `check_availability`. The spike's executor returns S-1's canned three slots and answers any other tool with `NOT_FOUND`.
3. The model writes the answer.

**For each turn it records:**
- outcome, whether the tool call was correct, and every tool name called;
- per-call TTFT, duration, and tokens (input, cache read, cache write, output);
- streamed `text_delta` count;
- reasoning blocks, and whether signed reasoning was replayed on the second call;
- any `<reasoning>`/`<thinking>` tag that reached the patient-visible text;
- estimated cost from the profile price table.

**Checks after the matrix** (skip with `--skip-checks`):
- a Sonnet turn's signed reasoning, stored in history, is accepted on the next turn by Sonnet, Haiku (same family), and gpt-oss (the reasoning is dropped from the request);
- gpt-oss rejects an invalid `reasoning_effort`, which proves Bedrock reads the field rather than ignoring it.

```bash
# from the repo root (after npm ci)
cd spikes/s1c-converse
AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npx tsx run.ts --runs 5 --budget 1
AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npx tsx run.ts --runs 5 --models gpt-oss-120b,gpt-oss-20b --skip-checks
```

- **Pacing:** calls are paced per model to the account's on-demand quota with a 10% margin: Claude 10 RPM, Nova 2 Lite 20, Nova Pro 25, gpt-oss 100.
- **Budget:** `--budget` is a hard stop on estimated spend.
- **Output:** `results/raw-<timestamp>.json` and `results/summary-<timestamp>.md`.
