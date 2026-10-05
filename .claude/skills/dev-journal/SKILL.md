---
name: dev-journal
description: >-
  How to document this project as it's built: dated first-person-plural entries in docs/journal/,
  Architecture Decision Records in docs/adr/, and how both roll up into the narrative
  README.md (which reads as a story, not a setup manual). Use it whenever something worth
  remembering happens: a decision is made or reversed, a spike or eval produces numbers,
  something breaks unexpectedly, a better approach turns up, or a milestone closes. Also
  use it when the user says "document this", "write this up", "journal entry", "add an
  ADR", "record this decision", "update the README story", or asks how the project got to
  where it is.
---

# Dev journal and decision records

The project is a portfolio piece. Its README tells the story of how it was built: the question, the decisions, what broke, what the evals showed. That story is only as good as the raw material captured *while it happened*. This skill is how you capture it. Three artifacts, three jobs:

| Artifact | Job | When |
|---|---|---|
| **Journal entry** (`docs/journal/YYYY-MM-DD-slug.md`) | What happened, why, what surprised us, with evidence | Anything story-worthy: a spike result, a surprising bug, an eval swing, a milestone |
| **ADR** (`docs/adr/NNNN-slug.md`) | One decision: context, options, choice, consequences | A significant technical choice is made, reversed, or confirmed by a spike |
| **README chapter** | The narrative a reviewer reads | At milestone boundaries, assembled from journal entries |

A reversed decision gets a **new** ADR that supersedes the old one; a refined one gets a dated amendment section instead (when and how: `docs/adr/README.md`). Don't rewrite history; the reversal is part of the story.

## Writing a journal entry

1. Create `docs/journal/YYYY-MM-DD-short-slug.md`, using today's date. More than one entry per day is fine.
2. Use this template. Leave out a section rather than pad it.

```markdown
# YYYY-MM-DD — <Title that states the finding, not the activity>

**Chapter:** <README chapter this feeds, see the table below>
**Milestone:** <M0–M4>
**Related:** <issue #, PR # (add it once the PR is open), ADR-NNN, PRD FR-xxx>

## What happened
Two to five short paragraphs: the situation and what we did.

## Why we chose what we chose
The reasoning, including options we rejected and why. This is the one list of the decisions the spec left open, each with the alternative it beat: the PR's "Decisions the spec left open" links here instead of repeating it, and the PR body isn't kept in the repo. Update it whenever a decision is added or settled.

## What surprised us
The part a reader will remember. Wrong assumptions, unexpected numbers, dead ends.

## Evidence
Numbers, commands, eval report paths, commit SHAs, links. Anything that lets a skeptic check.

## What's next
One to three bullets.
```

3. Add a row to the table in `docs/journal/README.md`.

**Voice.** First person plural. "We" means Nick and the AI agents; be honest about which did what ("the agent proposed X; Nick chose Y because…"). Plain language. Titles that state the finding ("Haiku 4.5 books correctly but forgets to confirm") beat titles that state the activity ("Ran evals").

**Evidence over adjectives.** "p95 turn latency dropped from 14.2 s to 6.8 s after lowering effort to `low`" beats "much faster". If you don't have a number, say what you'd measure. Never invent one: a fabricated metric in a portfolio is worse than none.

**Keep out:** secrets, account IDs, real personal data, and setup instructions (those go in `docs/runbooks/`).

## Writing or updating an ADR

1. Copy the template in `docs/adr/README.md` to `docs/adr/NNNN-slug.md` (next number, four digits).
2. Fill it in: context → options considered (with honest pros and cons) → decision → consequences (including "revisit if…") → validation.
3. Update the index table in `docs/adr/README.md`.
4. If a spike confirms a *Proposed* ADR:
   - add the evidence under **Validation**;
   - flip the status to **Accepted** with the date;
   - write a journal entry about what the spike showed.
5. If a decision is reversed:
   - write the new ADR;
   - set the old one's status to `Superseded by ADR-NNNN`;
   - explain the reversal in a journal entry. Reversals make great story beats.

## Rolling up into the README

At a milestone boundary, or when asked, update the matching README chapter from its journal entries:

| Chapter | Milestone | Covers |
|---|---|---|
| 1. The question | M0 | Why this project, what "beyond a thin wrapper" means here |
| 2. Designing before building | M0 | Research, ADRs, PRD, the decisions that shaped everything |
| 3. The walking skeleton | M1 | First request through every layer; spike results |
| 4. Teaching the agent to schedule | M2 | Agent loop, tools, first eval scores, parallel-agent build |
| 5. What the evals showed | M3 | Model × effort matrix, failures found, fixes, model decision |
| 6. What I'd do next | M4 | Retrospective, cost, limits, roadmap |

README guidelines:
- **Tell it as a story.** A chapter opens with the tension (a question or a risk), walks through what we tried, and lands on the result, with one or two concrete numbers or quotes. Link to the journal entry for detail.
- **Keep each chapter short:** three to six paragraphs. The journal holds the depth.
- **Setup and configuration never go in the story.** Link to `docs/runbooks/` from the appendix.
- **Update the status line** at the top of the README when a milestone closes.
