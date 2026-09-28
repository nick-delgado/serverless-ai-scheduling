# ADR-001: Agent runtime — our own tool-use loop in Lambda

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Nick Delgado (+ Claude, drafting)
- **Related:** PRD FR-030…FR-037, ADR-002, ADR-007, ADR-008

## Context

The scheduling assistant needs an agent that can:
- hold a multi-turn conversation;
- decide when to call tools (availability, booking, rescheduling, lookups, escalation);
- run those tools against the patient's own data only;
- respond in a way the UI can stream.

The project exists to demonstrate an AI system "beyond basic prompting or a thin API wrapper". Reviewers should therefore be able to see and understand how the loop controls the model. We also need a runtime the **eval harness can drive directly** (in-process, with fakes and a frozen clock), without deploying anything.

Constraints:
- Serverless, pay-per-use, near-zero idle cost.
- Deployable with CloudFormation/SAM.
- TypeScript.

## Options considered

1. **Our own loop in Lambda.** A `while (stop_reason === "tool_use")` loop over the Anthropic Messages API on Bedrock, in a TypeScript package (`packages/agent`), invoked by a Lambda handler.
   - Pros:
     - Full control over authorization, limits, tracing, and streaming.
     - Trivially testable in-process.
     - Cheapest option, and native to SAM.
     - The engineering is visible to reviewers.
   - Cons: we own the loop's edge cases: parallel tool calls, errors, refusals, `max_tokens`.
2. **Anthropic SDK Tool Runner** (`client.beta.messages.toolRunner`). The SDK runs the loop over tools we define, with per-turn hooks.
   - Pros: less code.
   - Cons: a beta helper; it hides the part of the system we want to show; custom trace capture and streaming of tool-status events fit awkwardly.
3. **Strands Agents SDK** (AWS open source) in Lambda.
   - Pros: batteries included; AWS-native.
   - Cons: the framework owns the loop and adds abstraction between us and the model; harder to show original engineering.
4. **Amazon Bedrock AgentCore Runtime.** A managed, serverless agent host with session isolation, long runs, memory, gateway, and observability.
   - Pros: production-grade features; interesting to AWS-heavy teams.
   - Cons:
     - More moving parts than a proof-of-concept needs; container-style packaging.
     - Session/memory features overlap with what we get from DynamoDB for free.
     - Slower local iteration.
5. **Bedrock Agents (managed action groups).**
   - Pros: least code.
   - Cons: most black-box; hard to evaluate turn-by-turn; hard to enforce our identity-injection rule clearly.
6. **Claude Agent SDK.** Not a fit. It is a coding/filesystem agent harness.

## Decision

**Option 1: our own loop in `packages/agent`, invoked from a streaming Lambda.**

The loop's contract:

```ts
runAgentTurn({
  history,          // append-only prior messages (DynamoDB)
  userMessage,
  context,          // { patientId (from JWT), clinicTimezone, now: Clock }
  tools,            // ToolRegistry: Zod schema → JSON Schema; handlers get injected ctx
  llm,              // LlmClient interface (Bedrock impl, or a scripted fake in tests)
  modelProfile,     // model id + per-model params (effort/thinking) — ADR-002
  limits,           // maxIterations (8), maxToolCallsPerTurn, token budget
  onEvent,          // stream sink: status | text_delta | done | error (ADR-007)
}) → { newMessages, trace, usage }
```

Loop requirements:
- Execute **parallel tool calls concurrently**, and return all `tool_result` blocks in **one** user message.
- A failed tool returns `is_error: true` with a safe message. Tool errors never throw out of the loop.
- **Identity injection:** the handler receives `ctx.patientId`. Tool input schemas never contain it.
- Check `stop_reason` before reading content:
  - `refusal`: apply the client-side fallback policy (Bedrock has no server-side fallbacks).
  - `max_tokens`: retry once with a higher budget, then fail gracefully.
- Iteration cap. When it's hit, the agent apologizes and offers escalation. It never spins.
- **Trace capture:** every model call and tool call is recorded (inputs, outputs, latency, tokens). The chat handler persists the trace; the eval harness grades it.
- **Prompt caching:** stable tools and system prompt first, with a cache breakpoint after them. Volatile context (today's date, patient first name) goes after the breakpoint.

## Consequences

- We write and test roughly 200–300 lines of loop code, and unit-test it with a scripted fake `LlmClient` (no network).
- The same function serves production (Lambda) and evaluation (in-process), so eval results reflect real behavior.
- We must keep up with API changes ourselves (e.g., new stop reasons). This is mitigated by using SDK types, not hand-rolled ones.
- **Revisit if** sessions need to outlive a single request, or we need managed memory, browser, or code-interpreter tools. AgentCore Runtime would then be the natural next step, and the `LlmClient`/`ToolRegistry` seams make that move incremental.

## Validation

- Unit tests for the loop's edge cases: parallel calls, a tool error, refusal, `max_tokens`, the iteration cap.
- The eval harness (ADR-008) runs this exact function. Task success and trajectory metrics validate it.
