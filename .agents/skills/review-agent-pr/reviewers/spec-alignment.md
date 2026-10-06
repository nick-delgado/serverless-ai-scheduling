# Brief: spec-alignment reviewer

**Question you answer:** does this PR build what was asked for, only what was asked for, and
in a direction consistent with where the project is going?

Finding prefix: `SPEC`. Categories: `missing-requirement`, `partial-requirement`,
`deviation`, `scope-creep`, `direction-conflict`, `unstated-assumption`, `overclaim`.

The manifest lists the task-level spec sources (the linked issue or ticket, or spec files)
and the project-level direction sources (roadmap, architecture, ADRs). If the manifest says
no task spec was found, skip steps 1 and 2, say so under "Not reviewed", and do steps 3 to 5.

## Method

### 1. Extract the requirements

Read every task-level spec source completely, including issue comments: requirements are
often refined there, and later comments override earlier text. The files under
`<RUN_DIR>/spec/` are the task's own issues: read each to its last line. The files under
`<RUN_DIR>/spec/background/` are the issues and PRs they link to: search them and read the
parts the spec points to, not the whole files.

Write an atomic, numbered list:

- `R1`, `R2`, ...: each one a single checkable statement, with its source and the exact
  quote.
- Include acceptance criteria, constraints ("must not change the public API"), and explicit
  non-goals ("out of scope: pagination").
- On a re-review, the owner's decisions listed in the manifest are requirements too. Give
  each its own row, with the source `decision <commit>/<ID>`, and say whether it stays
  within the issue or adds to it. The traceability table then shows how much the decisions
  have added.
- Where the spec is ambiguous or silent on something the implementation had to decide, add
  it as an open question `Q1`, `Q2`, ... Do not resolve it yourself.

### 2. Trace each requirement into the code

For every requirement, find where the PR implements it and read that code.

| Status | Meaning |
|---|---|
| implemented | The behaviour is present and matches the quote. Cite `file:line`. |
| partial | Some of it is present. Say what is missing. |
| missing | Nothing in the PR addresses it. |
| deviates | Something addresses it but behaves differently from the quote. |
| not verifiable | Cannot be determined by reading the code. Say why. |

`partial`, `missing` and `deviates` each become a finding. "Measured against" is the spec
quote. A missing or contradicted acceptance criterion is at least major. A violated explicit
constraint or non-goal is a blocker.

Trace by reading the implementation, not by matching names: a function called
`validateInput` is not evidence that input is validated.

### 3. Trace each change back to a requirement (scope)

Go through the diff file by file, hunk by hunk. For each change decide:

- it implements requirement `R<n>`;
- it is necessary support for one (a type, a migration, wiring, a test);
- or nothing in the spec asks for it.

The third kind is `scope-creep`: extra features, refactors of untouched areas, dependency
upgrades, new configuration, behaviour changes to existing features. Severity depends on
risk: a behaviour change to an existing feature is major, an unrelated tidy-up is minor.

With no task spec, use the PR title and description as the stated intent and apply the same
test.

### 4. Check the direction

Read the direction sources. Report a `direction-conflict` when the PR:

- contradicts a stated goal, principle or accepted ADR;
- builds on something the roadmap says is being removed or replaced;
- makes a later planned step harder (hardcodes what the plan says will be configurable,
  couples what the plan says will be separated);
- solves the task in a way that satisfies the ticket's wording but defeats its evident
  purpose.

Quote the goal and the code.

For each open question `Q<n>` from step 1, find what the implementation assumed and report
it as `unstated-assumption` (minor, or major if the assumption is hard to reverse). These
are the raw material for the root-cause analysis: they show where the spec left the agent
to guess. Their action is `needs owner decision`, as is any finding where two spec sources
disagree: state the question and the options, and recommend one, as the finding schema's
"Suggestions and options" describes. The owner decides; your recommendation is advice.

### 5. Compare the PR description with the diff

Agents often describe what they intended rather than what they did. For each claim in the PR
description ("adds validation", "all endpoints covered", "tests added", "no breaking
changes"), check it against the diff. A claim the diff does not support is an `overclaim`
finding, major. A broad claim ("all endpoints covered") counts once, however many cases it
misses.

## Required: the traceability tables

Put this table at the end of the Findings section (after the last finding, or after `No
findings.`), under the exact heading `### Spec traceability`. The report publishes it as
is. A review without it is incomplete, and a script checks for it.

```markdown
| Req | Requirement (quoted) | Source | Status | Evidence |
|---|---|---|---|---|
| R1 | "Users can export invoices as CSV" | issue #42 | implemented | `src/export/csv.ts:12-48` |
| R2 | "Export respects the active filters" | issue #42 | missing | — (SPEC-1) |
```

Follow it with `### Unrequested changes`: a table of the scope-creep items (file, what
changed, finding ID), or `None.`

## Ledger requirements

- "Sources read": every spec and direction source, including each issue comment thread.
- "Checks performed": one row per diff file for the scope check, one per direction source,
  one per PR-description claim. Do not repeat the requirements here: they are the rows of
  the traceability table.
