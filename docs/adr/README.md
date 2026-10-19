# Architecture Decision Records

Each ADR records one significant decision: the context, the options we weighed, what we chose, and what that costs us. Once **Accepted**, an ADR changes in one of two ways:

- **Reversing the decision** (choosing a different option) takes a new ADR that supersedes the old one. Update the old one's status line.
- **Refining it** (details settled while building, or a configuration value such as a model profile) takes a dated `## Amendment (YYYY-MM-DD): <topic> (#N)` section at the end. The header names each amendment, in the status line (`Accepted (amended YYYY-MM-DD: <topic>, #N)`) or an `**Amended:**` line, and each body line it changes or makes false (search the body for each name, count and "only"/"the one" claim the amendment touches) keeps its accepted wording and gets a short italic pointer appended (a few words and a link; the detail lives in the amendment), such as *(Superseded by the [amendment](#…): …)* or *(Refined by …)*. There is no in-place correction: a stale detail is a refinement, even when an issue or audit proposes new wording for the line. `scripts/adr-history.test.ts` checks that every Accepted or amended ADR keeps its body lines and pointers as on `main`, and that each amendment's date is in its ADR's status or `**Amended:**` line and in its row below.

When it isn't clear which one a change is, ask the owner.

**Statuses:** `Proposed` (awaiting a spike or review) → `Accepted` → `Superseded by ADR-XXX` / `Deprecated`.

| ADR | Title | Status |
|---|---|---|
| [001](0001-agent-runtime.md) | Agent runtime: our own tool-use loop in Lambda | Accepted (amended 2026-10-03) |
| [002](0002-model-and-bedrock-client.md) | Model selection and Bedrock client | Client decision superseded by ADR-010; model-selection method stands; amended 2026-10-09; production profile `sonnet-4.6` at effort `high`, amended 2026-10-12; NFR-001 query after #38, amended 2026-10-14; judge calibration 42/49 on `judge.v1` (#159), amended 2026-10-16; rubric average 4.77 on `judge.v2` (#295), amended 2026-10-18 |
| [003](0003-iac-layout.md) | Infrastructure as code: SAM, one template per stack | Accepted (amended 2026-09-29, 2026-10-03, 2026-10-04, 2026-10-08, 2026-10-14) |
| [004](0004-data-model.md) | Data model: DynamoDB single-table design | Accepted (amended 2026-09-29, 2026-10-02, 2026-10-03, 2026-10-19) |
| [005](0005-auth.md) | Authentication and identity propagation | Accepted (amended 2026-10-03) |
| [006](0006-voice-transcription.md) | Voice transcription: browser → Transcribe Streaming | Accepted (spike S-3, #10; amended 2026-10-09, 2026-10-19) |
| [007](0007-chat-transport.md) | Chat transport: REST API + Lambda response streaming | Accepted (spike S-2, #7; amended 2026-10-03, twice; 2026-10-04; 2026-10-05, twice) |
| [008](0008-evaluation-strategy.md) | Evaluation strategy | Accepted (amended 2026-09-29, 2026-10-02, 2026-10-03, 2026-10-05, three times; 2026-10-07; 2026-10-09; 2026-10-10; 2026-10-11; 2026-10-15, twice; 2026-10-16; 2026-10-17, twice; 2026-10-18, twice; 2026-10-19, three times) |
| [009](0009-safety-and-privacy.md) | Safety, privacy, and abuse controls | Accepted (amended 2026-10-03, 2026-10-04, 2026-10-15, 2026-10-16, 2026-10-19) |
| [010](0010-provider-neutral-llm-layer.md) | Provider-neutral LLM layer via Bedrock Converse | Accepted (spike S-1c, #60; amended 2026-10-05) |

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
