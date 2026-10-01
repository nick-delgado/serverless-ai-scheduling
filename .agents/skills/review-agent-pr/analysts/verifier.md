# Brief: verifier

**Question you answer:** which of the reviewers' findings survive an honest attempt to
disprove them?

Four reviewers worked independently and wrote `<RUN_DIR>/findings/*.md`. Reviewers
over-report: they misread code, quote rules that do not apply, and flag things that were
already there. Your main job is to try to refute every finding. What you cannot refute is
confirmed.

Reviewers also under-report: a "pass" is a claim too. So you also spot-check a sample of
the checks they passed, and, when the PR was reviewed before, settle what became of each
previous finding. Those are the only two ways you add findings; you do not review the PR
afresh.

## Method

For each finding, in every findings file:

1. **Does the evidence exist?** Open the cited location in `<RUN_DIR>/worktree`. The quoted
   code must be there. If the line numbers are off but the code is nearby, correct the
   location. If the code is not there, reject.
2. **Does the measure exist and apply?** Open the "Measured against" source. The quote must
   be there, and the rule must apply to this kind of file or situation. For a precedent,
   open the cited examples and check they really agree with each other. For a spec clause,
   check that no later issue comment changed it.
3. **Is it this PR's doing?** Check the location against `<RUN_DIR>/diff.patch`. If the
   lines were not added or changed by the PR and the PR did not rely on them, reject as
   pre-existing.
4. **Could the PR have fixed it within its allowed scope?** Answer this for every finding
   that survived step 3, and record the answer in the finding (see the output format).
   - Establish the allowed scope once, from the spec material: the issue's owned paths or
     stated scope, files it says not to touch, contracts or shared files it says need
     sign-off. If the task states no limits, the scope is the whole repository and the
     answer is always yes.
   - Then look at where the finding's fix would have to be made. If every reasonable fix
     lies inside the scope, the answer is **yes**.
   - If the fix requires changing something outside it (a contract, a shared file,
     pre-existing code the task did not allow the PR to touch), the answer is **no**. Do
     not reject the finding: keep it, set its action to `for the owner` (step 8) and cap
     the severity at minor.
   - A finding with one fix inside the scope and another outside it is a **yes**: the PR
     could have done the in-scope one.
5. **Is it already machine-enforced?** If the manifest lists a linter, type checker or CI
   check that covers it, reject: CI reports it.
6. **Look for the counter-evidence the reviewer may have missed.**
   - "Unused" or "dead": search for call sites, dynamic references, registrations, exports
     consumed elsewhere.
   - "Duplicate of X": read both. Same behaviour, or only similar names?
   - "Missing requirement": search the whole diff for an implementation somewhere the
     reviewer did not look.
   - "Untested": search the test tree for an existing test.
   - "Scope creep": is the change needed for a requirement to work?
   - "Swallowed error" or "needless defence": is there a caller or a documented contract
     that makes it necessary?
7. **Is the severity right?** Keep the reviewer's severity unless a row of the severity
   table or the boundary cases in the finding schema says otherwise. To change it, quote
   that row. If the facts you verified changed (part of the claim fell away), re-grade
   what remains against the table. "Both levels are defensible" is a reason to keep the
   reviewer's level, not to change it.
8. **Who acts on it?** Settle the "Action" field, using the table in the finding schema.
   The authoring agent will fix everything marked `fix now` without asking, so be strict:
   - `for the owner` when step 4 answered no.
   - `needs owner decision` when the right outcome is not settled by the spec, a documented
     rule or the code: two sources conflict, the spec is silent on the behaviour, or the
     suggested fix begins with "decide", "confirm" or "ask". If the finding also has a part
     that is right under every option (a missing test, a record of the decision), split
     that part out as its own `fix now` finding with a suffixed ID (`SPEC-2a`).
   - `fix now` otherwise.

Then, across all files:

9. **Deduplicate.** Merge two findings only when they point at the same code and the same
   fix would resolve both: keep one, keep the clearest evidence, and list the other ID as
   merged into it. The same problem at several locations is one finding with several
   locations. Two findings that share a cause but need different fixes (the code and the
   missing record of a decision, say) stay separate; add a "Related:" line to each naming
   the other.

10. **Settle the suggestions and options.** The reviewers drafted them from inside one
    area; you see every finding and are invested in neither the code nor the findings. You
    are the last to shape what the authoring agent will do and what the owner will be
    asked, so this step decides how useful the report is. Hold each confirmed finding to
    "Suggestions and options" in the finding schema:
    - **Suggested fix:** check it against the code. Is it correct, the smallest fix that
      resolves the finding, free of any product decision, and does it use what already
      exists? Do two findings' fixes touch the same code, conflict, or make each other
      unnecessary? Then make them consistent and say so in each. Rewrite what falls short.
    - **Done when:** present and checkable.
    - **Options:** two to four real alternatives, each with its consequence. Add the one the
      reviewer missed, including "keep as is" when the code as written is a defensible
      choice, and drop the ones nobody would take.
    - **Recommendation:** make your own judgement, from the spec, the direction documents
      and the owner's earlier decisions in the manifest, not from the reviewer's draft or
      the authoring agent's choice. Cite the source. If the sources do not favour any
      option, say so and recommend the cheapest to reverse.

    Note in the finding's "Verification" field what you changed.

When you are unsure after checking, keep the finding and set its confidence to `low`. Do not
reject because a finding is inconvenient or small; reject only for a stated reason from the
steps above.

## Spot-check the passes

Choose passed checks from the reviewers' "Checks performed" tables and the "Behaviour
coverage" table, and try to break each one the way you would a finding: open the code, and
for a test, work out whether it would really fail if the behaviour were broken.

- How many: 8 when there are confirmed findings; 15 when there are none, since then nothing
  else in this review has been looked at twice.
- Which: at least half from test adequacy and spec traceability, where a wrong "pass" does
  most harm; prefer checks with a vague scope or no citation, and every reviewer at least
  once.
- A pass that does not hold becomes a finding, in the finding-schema format with the ID
  prefix `VER` (`VER-1`), and goes through steps 1 to 10 like any other.
- Also check the citations in the rows you sample: a line number that points at the wrong
  code is corrected in the table you copy, and noted.

## Previous findings (re-review only)

If `<RUN_DIR>/previous/report.md` exists, the PR was reviewed before. List every finding in
it: the full blocks, the rows of every table, and any "Previous findings" table it carries
forward from earlier rounds. `<RUN_DIR>/previous/earlier/` may hold the reports of earlier
reviewed commits; add their findings too, except those a later round already settled as
`resolved` or `withdrawn`. Finding IDs restart in every round, so name a previous finding
by its round as well: `6c20495/SPEC-1`. For each, settle its status at
the current head:

| Status | When |
|---|---|
| `resolved` | The problem is gone. Cite the code or test that shows it (`file:line`). |
| `still present` | The problem is still there. Unless a reviewer reported it again, add it back as a confirmed finding under its original ID, re-checked through steps 1 to 10. |
| `decided` | The owner decided it (see `<RUN_DIR>/previous/decisions.md` for decisions posted on the PR, and
`<RUN_DIR>/previous/responses.md`: the Decision column or a `decision:` note). Check that the code matches the decision; if it does not, it is `still present`. |
| `for the owner` | It was marked for the owner and nothing in this PR changed that. |
| `withdrawn` | On a second look it was never a problem (the earlier review was wrong). Say why. |

The responses file holds the authoring agent's responses, oldest first, each naming the
reviewed commit it answers and the commit it produced. They are claims ("fixed",
"disputed"). Treat them as
claims to check, not as evidence. For a disputed finding, judge the dispute on the code.

## Re-check mode

When your prompt says this is a re-check, there are no reviewer findings. The PR was
reviewed before, and the authoring agent has since changed it; the changes are in
`<RUN_DIR>/recheck.patch`. Your job is narrower than a review and wider than verification:

1. **Previous findings:** as above, for every finding. This is the main output.
2. **The changes themselves.** Read every hunk of `recheck.patch` and the code around it at
   the head. For each hunk, check that it does what the response claims, and look for new
   problems of the kinds the reviewers' briefs describe: a test that cannot fail the way its
   name says, a weakened check, a stale comment or doc left behind, a change outside the
   task's scope, behaviour the spec or the owner's decisions do not allow. Read the relevant
   brief in `<SKILL_DIR>/reviewers/` when a hunk falls in its area. A new problem becomes a
   `VER` finding and goes through steps 1 to 10.
3. **Spot checks** become the record of step 2: one row per hunk (or group of related
   hunks), with what you checked and the result.

Write the same output file with the same headings. In the verification summary, give each
reviewer a row reading `not run (re-check)`, and add a row `Verifier (re-check)` with the
`VER` findings. Under "Reviewer tables", carry the previous report's spec traceability
forward, updating the rows the changes affect, and write `Not produced (re-check).` under
the other two headings.

## Output: `<RUN_DIR>/verified.md`

```markdown
## Confirmed findings

<each surviving finding in the finding-schema block format, original ID kept, with these
fields added:>
- **Verification:** confirmed | confirmed, adjusted (<what changed and why>)
- **Fixable within the PR's scope:** yes | no — <where the fix would be made, and the scope statement that allows or forbids it>
- **Checked by verifier:** <the specific things you opened or searched to try to refute it>
- **Merged:** <other IDs folded into this one, or "none">

## Minor findings table

| ID | Severity | Action | Location | Problem | Suggested fix |
|---|---|---|---|---|---|
<one row per confirmed minor finding and nit whose action is `fix now` or `for the owner`;
one sentence per cell, the last cell holding the suggested fix and, after "Done when:", its
check; "None." if there are none. Findings that need the owner's decision are not in this
table: the report shows each of them in full, whatever its severity.>

## Rejected findings

| ID | Reviewer's claim | Reason rejected | What was checked |
|---|---|---|---|

<then a second table, "Merged": ID, folded into, why>

## Spot checks

| Reviewer | Check (as the reviewer wrote it) | What you did | Result |
|---|---|---|---|
<one row per sampled pass; Result is `holds`, `holds, citation corrected`, or `does not hold: VER-n`>

## Previous findings

| ID | Before (severity, action) | Agent's response | Status now | Evidence |
|---|---|---|---|---|
<one row per previous finding; or the single line "No previous review.">

## Verification summary

| Reviewer | Reported | Confirmed | Adjusted | Merged | Rejected |
|---|---|---|---|---|---|

## Reviewer tables

### Spec traceability
### Unrequested changes
### Behaviour coverage
```

The report is assembled from this file by a script that finds sections by their headings,
so use exactly these `##` and `###` headings, in this order, and no other `##` headings.

- Order the confirmed findings by severity, blockers first.
- The minor findings table is what the report shows for minors and nits, and the script
  sorts its rows into the report's three groups by the Action cell. Write that cell as
  exactly `fix now`, `needs owner decision` or `for the owner`. Keep each row to one line;
  the full blocks above remain the record.
- Under "Reviewer tables", copy each reviewer's table of that name, corrected where a
  rejection or adjustment changes a row. Write `Not produced.` under a heading whose
  reviewer supplied no table.
- Every `path:line` you write, including in copied tables, must be a line of the file in
  `<RUN_DIR>/worktree`, never a position in `diff.patch`. A script checks every citation in
  this file after you finish, and invalid ones are sent back to you.
