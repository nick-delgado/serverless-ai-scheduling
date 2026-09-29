# Architecture Decision Records

Each ADR records one significant decision: the context, the options we weighed, what we chose, and what that costs us. ADRs are immutable once **Accepted**. To change course, write a new ADR that supersedes the old one, and update the old one's status line.

**Statuses:** `Proposed` (awaiting a spike or review) → `Accepted` → `Superseded by ADR-XXX` / `Deprecated`.

| ADR | Title | Status |
|---|---|---|
| [001](0001-agent-runtime.md) | Agent runtime: our own tool-use loop in Lambda | Accepted |
| [002](0002-model-and-bedrock-client.md) | Model selection and Bedrock client | Proposed; interim dev path accepted (Sonnet 4.6, bedrock-runtime) |
| [003](0003-iac-layout.md) | Infrastructure as code: SAM, one template per stack | Accepted |
| [004](0004-data-model.md) | Data model: DynamoDB single-table design | Accepted |
| [005](0005-auth.md) | Authentication and identity propagation | Accepted |
| [006](0006-voice-transcription.md) | Voice transcription: browser → Transcribe Streaming | Proposed (spike S-3) |
| [007](0007-chat-transport.md) | Chat transport: REST API + Lambda response streaming | Accepted (spike S-2, #7) |
| [008](0008-evaluation-strategy.md) | Evaluation strategy | Accepted |
| [009](0009-safety-and-privacy.md) | Safety, privacy, and abuse controls | Accepted |

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
