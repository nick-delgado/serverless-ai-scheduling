# Brief: root-cause analyst

**Question you answer:** why did the agent produce each of these problems, and what should
change in the project so the next agent does not?

A review that only lists defects gets the same defects again on the next PR. The author was
an AI agent: it acted on the instructions, skills, specs and existing code it could see, and
on the checks that did or did not stop it. Each confirmed finding is therefore evidence
about that environment. Your job is to read the environment the way the agent met it and
find what led it astray.

You have only the PR and the repository. You do not have the agent's prompt or transcript.
Every cause you name is an inference, and must be labelled with how strong the evidence is.

## Inputs

- `<RUN_DIR>/verified.md`: the confirmed findings. Ignore rejected ones.
- `<RUN_DIR>/findings/*.md`: the sections headed "Observations for root-cause analysis",
  the open questions and unstated assumptions from the spec reviewer.
- The manifest's **agent process inventory** and **spec sources**. Read every file in the
  inventory completely: instruction files, skills, subagent definitions, templates.
- `<SKILL_DIR>/references/cause-taxonomy.md`: the causes you may assign and the evidence
  each requires. Read it first.

## Depth by severity

Spend the effort where a process change would pay for itself.

| Severity | Analysis | Proposals |
|---|---|---|
| blocker, major | Full: steps 1 and 2 below, with a "Cause analysis" block each. | Yes. |
| minor | One line: the primary cause and one sentence of evidence, in the "Cause summary" table only. Assign it from what you learned analysing the blockers and majors plus one targeted look; if no cause is evident, write `not assigned`. | Only as part of a pattern: two or more minors with the same cause, or a minor that shares its cause with a blocker or major. |
| nit | None. List the IDs in one line under the "Cause summary" table. | Never. |

Minors are kept because they reveal patterns: three small guesses caused by one silent spec
are one real problem.

**A pattern is promoted.** When three or more minors share a primary cause, treat that
cause as you would a major finding: do steps 1 and 2 in full for it, and write one "Cause
analysis" block headed `### Pattern: <cause>` that covers the findings together. Proposals
may then address it like any other.

## Method

### 1. Reconstruct what the agent could see

For each blocker and major finding, establish:

- **What instruction covered this?** Search the inventory for anything that speaks to the
  issue. Quote it with `path:line`, or state that nothing does and list what you searched.
- **Was it in the agent's path?** An instruction in a root `AGENTS.md` or `CLAUDE.md` is
  loaded automatically. A rule in `docs/architecture/layers.md` that no instruction file
  points to is only seen if the agent goes looking. A skill is only used if its description
  matches the task.
- **What did the spec say?** Quote the relevant part of the issue, or note its silence.
- **What did the surrounding code show?** Open the neighbours of the changed code. Agents
  imitate what they see. If the existing code does the same wrong thing, that is the
  strongest explanation available.
- **What would have stopped it?** Is there a test, lint rule, type or CI check that could
  have failed on this? Does one exist that should have and did not?

### 2. Assign causes

Give each blocker and major one primary cause and any contributing causes, from the
taxonomy; give each minor a primary cause only. Apply
its evidence requirements strictly, and apply the counterfactual test: *if this one thing
had been different, would a competent agent have plausibly produced the right result?* If
the answer is no, it is not the cause.

Set confidence:

- **high:** direct evidence. The misleading text, the contradictory rules or the copied
  precedent can be quoted.
- **medium:** the absence of guidance is shown by a documented search, and the counterfactual
  is plausible.
- **low:** consistent with the evidence but not distinguishable from other explanations.

`agent-lapse` is what remains when the instruction was clear, in the agent's path and
unambiguous. Do not reach for it early, and do not avoid it when it is true: inventing a
documentation problem to explain every lapse produces documentation bloat.

### 3. Find the patterns

Group findings that share a cause. Three findings from one missing sentence in `AGENTS.md`
are one problem. A pattern across findings is stronger evidence than any single finding,
and it is what makes a proposal worth its cost.

### 4. Propose improvements

For each cause or pattern worth acting on, write a concrete proposal. Rules:

- **Prefer a mechanical guardrail to more prose.** A lint rule, a type, a test or a CI check
  cannot be skimmed past. If the issue can be detected mechanically, propose that first, and
  propose prose only as a complement.
- **Answer the test question for every blocker and major:** could a unit, integration or
  architectural test have caught this? If yes, describe the test: what it asserts, where it
  lives, and why it would have failed on this PR.
- **Edit before adding.** Fix or sharpen the existing sentence, or move it to where the
  agent will load it, before creating a new file. Propose a new skill only when the guidance
  is a multi-step procedure that applies to a recognisable kind of task.
- **Write the actual change.** Give the target file and the exact text to add or replace, as
  a diff or a before/after block, in the voice and format of that file. "Clarify the docs"
  is not a proposal.
- **Keep instruction files lean.** Every added line costs attention on every future task.
  Do not propose a rule for a one-off or a nit. Say so when the right action is no action.
- **State the expected effect and the cost**, including what the change could make worse.
- **Read the harness that ran.** When a cause may lie in a harness skill, read the
  installed copy (`<SKILL_DIR>` and its sibling skill directories), not a copy the project
  may have committed under `.agents/skills/` or `.claude/skills/`, which can be older.
- **Harness skills are not the project's to change.** The skills `review-agent-pr`,
  `address-pr-review` and `improve-agent-process` come from the agent-review-harness
  repository and are installed copies; an edit in the project would be overwritten on the
  next update. When a cause lies in one of them, write the proposal with type
  `harness-change`, name the skill and the change, and leave it to be raised with the
  harness's maintainers. It is not subject to the "wait for recurrence" rule: say plainly
  that the harness should change.

## Output: `<RUN_DIR>/root-cause.md`

```markdown
## Cause analysis

<one block per blocker and major finding, and one per promoted pattern>
### <Finding ID>: <finding title>
- **Primary cause:** <taxonomy id>
- **Contributing:** <taxonomy ids, or "none">
- **Confidence:** high | medium | low
- **Evidence:** <quotes with path:line; or the searches that show an absence>
- **Counterfactual:** <what would have had to be different, in one sentence>
- **Could a test or check have caught it?** yes | partly | no — <which kind, and how>

## Cause summary

| Finding | Severity | Failure class | Primary cause | Confidence | Evidence |
|---|---|---|---|---|---|
<one row per blocker, major and minor; the evidence cell is one sentence with its path:line.
The failure class is exactly one from the tracked list in the manifest (or, if it has none,
`<SKILL_DIR>/references/failure-classes.md`), or `other`. It names what went wrong, which
stays stable while causes shift; the project counts it to see whether its changes worked.>

Nits, not analysed: <IDs, or "none">

## Patterns

| Cause | Findings | What they have in common |
|---|---|---|

## Proposals

### P1: <imperative title>
- **Type:** doc-edit | skill-edit | new-skill | prompt-or-template-edit | new-test | new-lint-or-ci-check | spec-practice | harness-change | no-action
- **Addresses:** <finding IDs> (cause: <taxonomy id>)
- **Confidence:** high | medium | low
- **Target:** `path/to/file`
- **Change:**
  ```diff
  <the exact edit>
  ```
- **Expected effect:** <what the next agent will do differently, and why>
- **Cost and risk:** <added instruction length, maintenance, false positives>

## Not explained

<findings for which no cause reached low confidence, and what additional evidence (the
agent's prompt, its transcript) would settle it>
```

Order proposals by how many confirmed findings, weighted by severity, each would have
prevented.

### Length and headings

Your output is posted as one comment on the project's tracking issue for agent process
findings, assembled by a script that finds sections by heading. Use exactly the five `##`
headings above, in that order. "Cause analysis" is the full record and stays in the run
directory. The other four sections are copied into the comment as written, so they must be
short. A later step reads these comments across many reviews to decide which changes are
worth making, so name causes with the taxonomy IDs exactly and make each proposal
understandable without the rest of the review:

- **Cause summary:** one line per blocker, major and minor.
- **Patterns:** one line per pattern.
- **Proposals:** the whole section under 9,000 characters. Per proposal, "Expected effect"
  and "Cost and risk" are one sentence each, and the diff contains only the changed lines
  with the minimum context to place them. Put alternatives, caveats and reasoning in "Cause
  analysis", not here. Combine all `no-action` items into one proposal of two or three
  lines. If the section is still too long, cut the lowest-ranked proposals and list their
  titles in one closing line.
- **Not explained:** one line per item.
