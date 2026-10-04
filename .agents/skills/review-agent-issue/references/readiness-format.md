# Readiness review: output format

The readiness review is one comment on the issue. It is read by the project's owner, who
answers it, and later by the coding agent and the PR reviewer, who treat the owner's
answers as part of the spec. The readiness verifier writes it to
`<RUN_DIR>/readiness.md` in exactly this layout; the orchestrator posts it unchanged.

## Layout

````markdown
<!-- agent-pr-review:readiness round=<k> -->
## Readiness review (round <k>): <verdict>

**Issue:** #<n> <title> · **Read at:** <UTC time> · **Default branch:** `<branch>` @ `<short sha>`

<Two or three sentences: what the issue asks for, and what most needs settling before work
starts. Nothing about who wrote the issue or why.>

Round: <k> · Questions: <n> · Assumptions: <n> · Suggested edits: <n> · Harness version: <version>

**To answer:** reply on this issue with one line per item, in the form shown under each
(`Decision r<k>/<ID>: <answer>`): an option's letter or your own words for a question,
"accept" or "reject" for an edit, and your correction for an assumption you disagree with.
Then ask for the apply step, which writes your answers into the issue's description.

### Questions

<at most seven, most consequential first; or "None.">

#### Q-1: <the question, answerable without reading code>

- **Why it matters:** <what goes wrong, and how expensively, if the agent guesses wrong>
- **Source:** <the issue's words, or the PRD, ADR or decision it conflicts with, quoted with
  its location; or "the issue is silent on this">
- **Options:**
  - (a) <option>: <what it means for the code and for users>. Scope: within the issue | adds <...>
  - (b) <option>: <...>. Scope: <...>
- **Recommendation:** (<letter>), because <reason, citing a source the owner can check>
- **Reply:** `Decision r<k>/Q-1: (<letter>)`

### Assumptions

The coding agent will follow these unless you correct them.

| ID | Assumption | Basis | To correct |
|---|---|---|---|
| A-1 | <what the agent will do> | <the source or convention it follows> | `Decision r<k>/A-1: <your correction>` |

### Suggested edits to the issue

<or "None.">

#### E-1: <what the edit fixes, in one line>

Before:
```text
<the exact current text of the issue description that the edit replaces; empty for an addition>
```
After:
```text
<the replacement>
```
- **Reply:** `Decision r<k>/E-1: accept` (or `reject`)

### Reuse, dependencies and risks

- **Reuse:** <existing code to use instead of writing new, with path:line>
- **Dependencies:** <issues or PRs this work needs, and their state>
- **Overlaps:** <open PRs touching the same files>
- **Size:** <estimate, and a suggested split if the issue is too broad>

<details>
<summary>What was checked</summary>

<the requirements list (R-1, R-2, ...) with whether each acceptance criterion can be
tested; the sources read; what was not checked and why>

</details>
````

## Verdict

| Verdict | When |
|---|---|
| **Not ready** | The issue should be split or rewritten first: its goal is unclear, it contradicts the project's direction, or it is too broad for one PR. Say what to do. |
| **Needs answers** | At least one question. |
| **Ready with assumptions** | No questions, but assumptions or suggested edits worth a look. |
| **Ready** | Nothing to settle. |

The review is advisory: the owner decides whether work starts.

## Rules

- **A question earns its place** only if a reasonable implementer could go two ways and a
  wrong guess would cost a fix round, rework, or a behaviour the owner did not want. Every
  other open point is an assumption. At most seven questions; anything beyond becomes an
  assumption marked "(would have asked)".
- **Options are real alternatives** with their consequences and scope labels; recommend
  one, preferring what stays within the issue, and cite why.
- **Never re-ask** what an earlier round, an applied decision on this issue, or a decision
  recorded elsewhere in the project (an ADR, the PRD, an owner decision on another PR)
  already settled; cite it as the basis of an assumption instead.
- **Suggested edits are exact:** the "Before" text exists verbatim in the current
  description, so the apply step can make the change mechanically.
- **Line numbers** are lines of files at the default branch's commit named in the header.
