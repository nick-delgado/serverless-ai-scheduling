# 2026-09-29 — Denied the models we planned for, we made the agent speak to any model Bedrock serves

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #60, #57, ADR-010, ADR-002, ADR-007, spike S-1c (`spikes/s1c-converse/`)

## What happened

The plan in ADR-002 was to run the agent on Claude Opus 5 or Sonnet 5. AWS denied access to both on this account, and OpenAI's proprietary GPT-5.x models on Bedrock turned out to be blocked the same way. That left an agent loop written against Anthropic's Messages API types, and an eval matrix (ADR-008) with only two Claude models to compare.

A quick probe sent our real tool definitions through the Bedrock Converse API. Nova 2 Lite, Nova Pro, gpt-oss-120b, gpt-oss-20b, and Sonnet 4.6 all answered with a correct `check_availability` call. Nick decided that Converse becomes the only transport, and that OpenAI models are used only through Bedrock.

An agent then rebuilt the seam:
- `packages/contracts` gained provider-neutral content blocks: text, tool_use, tool_result, and an opaque reasoning block tagged with the model family that produced it.
- `LlmClient` now speaks only those blocks, and a new `ConverseLlmClient` translates them to Converse.
- The loop kept every behaviour its tests pinned down. Every existing loop test was adapted and still passes.
- We deleted the Anthropic SDK from the agent package.

## Why we chose what we chose

Adding one client per vendor would have leaked two or three wire formats into history. Stored conversations would have become provider-specific. Converse already models tool use, reasoning, cache points, and usage, and it keeps IAM, logging, and quotas in one place.

The cost is a translation layer we own. Our answer is to keep every model difference in the profile, as data, not in branches:
- the reasoning switch;
- where cache points are allowed;
- whether reasoning can be sent back;
- an inline reasoning tag to hide.

## What surprised us

- **Every model disagrees about cache points.** Claude takes them in tools, system, and messages. Nova takes them only in `system`: one in `tools`, or after a tool result, is a ValidationException. gpt-oss rejects any cache point with an *AccessDenied* error, not a validation error.
- **Reasoning isn't portable, even within a vendor.**
  - Claude validates the reasoning signature on the way back.
  - Nova 2 Lite returns `[REDACTED]` reasoning and accepts it back.
  - Nova Pro rejects any reasoning block in history, with the baffling message "User messages cannot contain reasoning content".

  Hence the opaque, family-tagged block and a per-profile replay switch.
- **Two models think out loud in the text the patient would see.** Nova Pro writes `<thinking>…</thinking>` before a tool call. The bigger surprise came from the live run: gpt-oss-120b put `<reasoning>…</reasoning>` in the answer text in 2 of 5 turns, *in addition to* its proper reasoning blocks. The adapter now moves a leading tagged section into a reasoning block and never streams it. The rerun had 0 leaks in 10 turns. We found this only because the spike checked the text a patient would read, not just the tool calls.
- **gpt-oss streams in lumps.** Claude and Nova sent 26–80 text deltas per turn; gpt-oss sent 2–4. The typewriter buffer from ADR-007 is what will make it feel alive.

## Evidence

S-1c ran the production path (`runAgentTurn` over `ConverseLlmClient`) for five turns per profile, paced to each model's quota. Estimated spend was about $0.16. Full table: ADR-010.

| Profile | Correct tool call | Turn p50 | $ per turn | Cache read on call B |
|---|---|---|---|---|
| sonnet-4.6 | 5/5 | 4.65 s | 0.0088 | 5/5 |
| haiku-4.5 | 5/5 | 2.51 s | 0.0077 | 0/5 (below its 4,096-token minimum) |
| nova-2-lite | 5/5 | 3.76 s | 0.0023 | 5/5 |
| nova-pro | 5/5 | 2.35 s | 0.0021 | 4/5 |
| gpt-oss-120b | 3/5 (it called `find_providers` first) | 3.19 s | 0.0010 | no caching |
| gpt-oss-20b | 5/5 | 1.57 s | 0.0003 | no caching |

- **Sonnet's signed reasoning round-trips.** It went back within every turn (5/5), and on the next turn it was accepted by Sonnet and by Haiku.
- **Parity with the retired client:** Sonnet's full turn was 5.16 s p50 in S-1 through `AnthropicBedrock`, and 4.65 s here. That's an indicative comparison, not a controlled one.
- **gpt-oss validates `reasoning_effort`.** A bogus value came back as "unknown variant `bogus`".
- Raw data: `spikes/s1c-converse/results/`.

## What's next

- #17 swaps the skeleton handler's direct Anthropic call for `runAgentTurn` + `ConverseLlmClient`, and adds the Nova and gpt-oss ARNs to the chat role.
- #30/#37: the eval matrix now has six models to rank. The first question is whether a $0.0003 turn is good enough.
