# 2026-09-29 — The agent loop never learns whose data it touches

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #15 (S3-01), #5, #17, ADR-001, ADR-002, ADR-007, PRD FR-035, FR-051

## What happened

Issue #15 built `runAgentTurn`, our own tool-use loop over the Messages API (ADR-001). It sits behind an `LlmClient` seam with two implementations: `BedrockLlmClient` (bedrock-runtime, per the ADR-002 interim decision) and `ScriptedLlmClient`, a fake that replays canned responses. It also has model profiles selected by `AGENT_MODEL_PROFILE`.

The loop was built at the same time as the tool registry (#5) and the walking skeleton (#7), each by a separate agent. Before any code, Nick fixed the seam between loop and tools in an issue comment: the loop consumes a `ToolExecutor` port defined in `packages/agent`, and `packages/tools` implements it structurally without importing the agent.

## Why we chose what we chose

- **The executor comes pre-bound to the patient.** ADR-001 sketched `runAgentTurn({ context: { patientId }, tools })`. We moved the binding out: the chat handler builds the executor from the verified JWT, and the loop never sees a patient ID. CLAUDE.md rule 1 is then enforced by the loop's type signature, not by discipline. A test checks that the patient's UUID never appears in any request the loop builds.
- **An iteration is a model call, retries included.** "Retry once on `max_tokens`" and "retry once on the fallback profile" both happen inside the cap of 8. So "never spins" is a single, checkable number.
- **Tools requested on the last allowed call don't run.** No model call would be left to report the result. A booking the patient never hears about is worse than an apology, so those calls get a `NOT_ALLOWED` error result and the patient gets the escalation offer.
- **Retried responses are discarded, not stored.** A truncated or refused reply never enters history. `newMessages` is therefore always a valid continuation: no `tool_use` without its `tool_result`, and nothing edited after the fact.
- **The loop emits `status` and `text_delta`; the handler owns `done` and `error`.** `done` needs the persisted message ID. The handler must also end the stream when the loop itself throws (ADR-007).
- **Two cache breakpoints, not one.** The first sits on the stable system block (tools render before it). The second rolls along on the last user block of each request, so iteration 2 reads iteration 1's prefix from cache. This matters most on Haiku 4.5: its 4,096-token minimum is above our tools and system prompt, so only the rolling breakpoint can ever cache there.

## What surprised us

- **Every loop test passed on the first run, which made us distrust them.** We broke the loop on purpose in six ways:
  - run parallel tools sequentially;
  - split tool results across user messages;
  - drop the system breakpoint;
  - mutate history in place;
  - skip the `max_tokens` retry;
  - run tools at the iteration cap.

  Each change turned at least one test red.
- **Streamed text can't be taken back.** If a reply is cut off at `max_tokens` or refused mid-stream, the patient has already seen part of it before the retry streams. The event contract has no "discard" event, so we asked for one in the PR instead of hiding the problem.
- **The trace can't record a hallucinated tool name.** `ToolCallTrace.name` is the `ToolName` enum. A call to a tool we never offered gets an `is_error` result but no trace row.

## Evidence

- `packages/agent`: 47 tests, all offline. The Bedrock adapter is tested through the real SDK with a fake `fetch`, which checks the `/model/<id>/invoke-with-response-stream` path and the `anthropic_version` body.
- No Bedrock calls were made. The account's quota is 10 requests/min and #7 was using it.

## What's next

- #16 writes the real system prompt (`{ version, stable, dynamic }`), and #17 wires loop + executor + streaming into `POST /api/chat`.
- Once the eval harness exists (#30), run the smoke suite on this loop and record the baseline.
