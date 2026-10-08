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

Round: <k> · Questions: <n> · Assumptions: <n> · Suggested edits: <n> · Spec commit: <full sha of the default branch read> · Harness version: <version>

**Check these first:** <the IDs of the (at most three) assumptions most likely to be wrong
and most expensive if they are, as `A-2, A-5`; or "none">

**To answer:** reply on this issue with one line per item, in the form shown under each
(`Decision r<k>/<ID>: <answer>`): an option's letter or your own words for a question,
"accept" or "reject" for an edit, "ok" or your correction for an assumption. To take every
recommendation and edit at once, `Decision r<k>/ALL: accept`; it does not cover the
assumptions under "Check these first" or those marked "(verify first)" or "(would have
asked)", which each need their own line. Only `Decision` lines are applied, never other
replies. Then ask for the apply step, which writes your answers into the issue's description.

### Questions

<at most seven, most consequential first; or "None.">

#### Q-1: <the question, answerable without reading code>

- **Why it matters:** <what goes wrong, and how expensively, if the agent guesses wrong>
- **Source:** <the issue's words, or the PRD, ADR or decision it conflicts with, quoted with
  its location; or "the issue is silent on this">
- **Options:** (one per line)
  - (a) <option>: <what it means for the code and for users>. Scope: within the issue | adds <...>
  - (b) <option>: <...>. Scope: <...>. Owned paths: + `<path>`
- **Edges:** <how the choice settles the cases at its edges, whichever apply: boundary
  inputs (empty, the exact limit, just past it); every point where two concurrent calls can
  interleave and one can lose; a case where an edit and an assumption both apply, and which
  wins; the artifact that counts as evidence (a file, a log, a test name), named; whether a
  list is complete or a minimum. Or "none: <why>". The apply step copies this line into the
  issue beside the answer.>
- **Recommendation:** (<letter>), because <reason, citing a source the owner can check>.
  No conditions here: if the recommended choice holds only under a condition, write the
  condition into that option's own text. The apply step records the chosen option's text,
  not the recommendation, and adds each path an option names after "Owned paths: +" to the
  issue's owned paths.
- **Reply:** `Decision r<k>/Q-1: (<letter>)`

### Assumptions

The coding agent will follow these unless you correct them.

| ID | Assumption | Basis | Makes stale | To correct |
|---|---|---|---|---|
| A-1 | <what the agent will do> | <the source or convention it follows> | <every line this assumption contradicts and the agent must update, as `path:line`, one per line (`<br>`): docs, comments, test names, and lines that name this issue's number; or "nothing"> | `Decision r<k>/A-1: <your correction>` |

An assumption the review could not check, such as how an external library, service or
platform behaves, is marked **(verify first)**: the agent establishes the behaviour before
building on it and pins it with a test, so a wrong assumption fails loudly instead of
silently.

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

- **Reuse:** <existing code to use instead of writing new, with path:line, and how: "import
  `<name>` from `<path>`"; "move `<name>` from `<path>` to a shared module and import it
  from both" (naming the owned path that adds); or a question, when neither fits>
- **Dependencies:** <issues or PRs this work needs, and their state>
- **Overlaps:** <open PRs touching the same files>
- **Size:** <estimate, and a suggested split if the issue is too broad>
- **Sibling issues:** <open issues touching the same files or behaviour, and any of their
  settled answers this issue must agree with; or "None found.">

**Relied on:** <the spec sections this review's questions, assumptions and recommendations
rest on, as `path` and heading (for example `docs/PRD.md` "FR-030"); a later refresh checks
whether any of them changed>

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
| **Still ready** | Refresh only: nothing the issue relied on changed in a way that matters. |

The review is advisory: the owner decides whether work starts.

## Rules

- **A question earns its place** only if a reasonable implementer could go two ways and a
  wrong guess would cost a fix round, rework, or a behaviour the owner did not want. A
  design the work must produce (sample data, how two flags interact, where a matcher's
  boundaries lie or how far a negation reaches, the rules that recognise an input) is a
  question, never an assumption: the agent would otherwise invent it. At most seven
  questions; anything beyond becomes an assumption marked "(would have asked)".
- **An assumption earns its place** only if it changes what the agent would do. It states
  something a reviewer can check against the code or the spec, names who acts ("the agent
  adds ..."), and predicts nothing about tests not yet written. One that names where code
  goes (a file, a function, a line) says whether the place is **required** or a
  **suggestion**; it is required only when something depends on it (a test, a doc, another
  issue's owned paths), which it names.
- **Option text says exactly what it covers.** The agent copies an option's words into
  code comments, docs and test names, so "everything", "all" or "the whole prompt" must be
  literally true; otherwise name what is covered.
- **Options are real alternatives** with their consequences and scope labels, one per line;
  recommend one, preferring what stays within the issue, and cite why. An option that needs
  a path outside the owned paths names it as "Owned paths: + `path`".
- **Reuse is said as an action:** import it, move it and share it, or ask. Never "like
  `X`" or "as `X` does": an agent told to follow an example copies it. Code that is not
  exported, or lies outside the owned paths, is reused by naming the export to add (and
  the owned path that needs) or by asking.
- **One story:** the questions' options, the assumptions, the summary and the suggested
  edits agree with each other and with the issue's goal. An issue line that an
  assumption's basis shows is wrong gets an edit; a stale line is cited the same way
  wherever it appears.
- **Never re-ask** what an earlier round, an applied decision on this issue, or a decision
  recorded elsewhere in the project (an ADR, the PRD, an owner decision on another PR)
  already settled; cite it as the basis of an assumption instead.
- **Edits to acceptance criteria state the observable first:** what a user or a test sees
  ("When <condition>, <observable result>"), then any detail. An edit that prescribes
  following a precedent ("test it as #142 does") is suggested only after checking that the
  precedent's preconditions hold for this issue (same kind of input, same infrastructure).
  Route a criterion a test cannot check to wherever the project records manual
  verification (a section of the issue template, the PR template, or the PR description).
- **Suggested edits are exact:** the "Before" text exists verbatim in the current
  description, so the apply step can make the change mechanically.
- **A prescribed command is run first.** An edit or criterion that names a command whose
  output is the check (a search, a listing, a git query) is run against the default branch
  before it is suggested, and its output is quoted under "What was checked". A command that
  builds, tests, installs or writes is not run here: mark it "(verify first)", so the agent
  runs it before relying on it.
- **Existing rules come first.** An edit or assumption that conflicts with a rule in the
  project's instruction files or templates (what counts as done, what needs a recorded
  decision, how results are reported) quotes both and becomes a question.
- **Line numbers** are lines of files at the default branch's commit named in the header.
