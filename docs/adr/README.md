# Architecture Decision Records

Each ADR records one significant decision: the context, the options we weighed, what we chose, and what that costs us. Once **Accepted**, an ADR changes in one of two ways:

- **Reversing the decision** (choosing a different option) takes a new ADR that supersedes the old one. Update the old one's status line.
- **Refining it** (details settled while building, or a configuration value such as a model profile) takes a dated `## Amendment (YYYY-MM-DD): <topic> (#N)` section at the end. The header names each amendment, in the status line (`Accepted (amended YYYY-MM-DD: <topic>, #N)`) or an `**Amended:**` line, and each body line it changes gets an italic pointer to it, such as *(Superseded by the [amendment](#…): …)* or *(Refined by …)*.

When it isn't clear which one a change is, ask the owner.

**Statuses:** `Proposed` (awaiting a spike or review) → `Accepted` → `Superseded by ADR-XXX` / `Deprecated`.

| ADR | Title | Status |
|---|---|---|
| [001](0001-agent-runtime.md) | Agent runtime: our own tool-use loop in Lambda | Accepted |
| [002](0002-model-and-bedrock-client.md) | Model selection and Bedrock client | Client decision superseded by ADR-010; model-selection method stands |
| [003](0003-iac-layout.md) | Infrastructure as code: SAM, one template per stack | Accepted |
| [004](0004-data-model.md) | Data model: DynamoDB single-table design | Accepted |
| [005](0005-auth.md) | Authentication and identity propagation | Accepted |
| [006](0006-voice-transcription.md) | Voice transcription: browser → Transcribe Streaming | Proposed (spike S-3) |
| [007](0007-chat-transport.md) | Chat transport: REST API + Lambda response streaming | Accepted (spike S-2, #7) |
| [008](0008-evaluation-strategy.md) | Evaluation strategy | Accepted |
| [009](0009-safety-and-privacy.md) | Safety, privacy, and abuse controls | Accepted |
| [010](0010-provider-neutral-llm-layer.md) | Provider-neutral LLM layer via Bedrock Converse | Accepted (spike S-1c, #60) |

## Template

```markdown
# ADR-NNN: Title

- **Status:** Proposed | Accepted | Superseded by ADR-XXX
- **Date:** YYYY-MM-DD
- **Deciders:** Nick Delgado (+ agent that drafted it)
- **Related:** PRD FR-xxx, ADR-yyy, issue #n

## Context
What forces are at play? What problem are we solving? What constraints apply?

## Options considered
1. **Option A** — summary. Pros / cons.
2. **Option B** — ...

## Decision
What we chose and the one-paragraph "why".

## Consequences
What becomes easier, what becomes harder, what we must now do (follow-ups), and what would make us revisit this.

## Validation
How we'll know this was right (spike, metric, eval result). Link evidence once available.
```
