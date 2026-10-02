# Output format for reviewers

Every reviewer writes one markdown file with the three sections below, in this order. The
verifier and the report are built from these files, so keep the headings and field names
exactly as shown.

## 1. Findings

One block per finding. If there are none, write `No findings.` under the heading.

```markdown
### <ID>: <one-line statement of the problem>

- **Severity:** blocker | major | minor | nit
- **Confidence:** high | medium | low
- **Category:** <reviewer-specific category, see your brief>
- **Location:** `path/to/file.ext:120-134` (add more lines for more locations)
- **Evidence:**
  ```<lang>
  <the code, quoted exactly from the PR head, trimmed to the relevant lines>
  ```
- **Measured against:** <source path:line or URL> — "<the rule, spec clause or precedent, quoted exactly>"
- **Why it matters:** <the concrete consequence, in one or two sentences>
- **Introduced by this PR:** yes | worsened | pre-existing (only report pre-existing when the PR depended on it)
- **Action:** fix now | needs owner decision | for the owner | noticed (see "Who acts on a finding")
- **Changed since the last review:** yes | no | first review (the verifier sets this; see "Re-reviews")

<for "fix now" and "for the owner":>
- **Suggested fix:** <the direction of the fix: what to change and where, naming the existing function, pattern, helper or doc to use>
- **Done when:** <the observable that shows it is fixed: the test that now fails on the defect, the claim that is now true, the line that is gone. Where the fix has several conditions or cases, name the check for each>

<for "needs owner decision", instead of the two fields above:>
- **Decision needed:** <the question, in one sentence the owner can answer without reading the code>
- **Options:**
  - (a) <option>: <what changes, what it costs, whether it is easy to reverse>. Scope: within the issue | adds <behaviour or files> beyond the issue
  - (b) <option>: <...>. Scope: <...>
  - (c) <...: two to four options; include "keep as is" when it is a real option, and "open a follow-up issue" when an option would add scope>
  <For a decision about how inputs are classified or matched, each option says what happens to the mixed and boundary cases (an input that fits two categories, an empty value, the exact limit).>
- **Recommendation:** (<letter>), because <the reason, tied to the spec, the project's direction documents, consistency with existing behaviour, or cost and reversibility; cite the source>
```

IDs use the reviewer's prefix and a running number: `STD-1`, `SMELL-1`, `SPEC-1`, `TEST-1`.

### Severity

| Level | Meaning |
|---|---|
| blocker | Must not merge: contradicts the spec or a documented hard rule, breaks an architectural boundary, removes or disables verification, or ships placeholder behaviour as real. |
| major | Should be fixed before merge: a clear violation of a documented standard, a missing requirement, duplicated logic that will drift, behaviour without a meaningful test. |
| minor | Worth fixing, safe to merge without: local maintainability issues, weak but present tests, small unrequested changes. |
| nit | Optional polish. Report at most five per reviewer, and on a re-review at most five in all (the verifier keeps the five that matter most). |

Boundary cases, decided here so that every reviewer and the verifier grade them the same
way:

| Case | Severity |
|---|---|
| A test whose name, or the PR description, claims it covers something the test cannot detect | major (the claim is what makes it major: a reader will trust it) |
| A broad claim ("every rule has a test that fails", "all paths are covered") that the tests do not fully support | one finding for the claim, fixed by correcting the claim or adding the tests; major only if a behaviour the spec asked for is untested. Each uncovered case is not a separate major: grade it on its own as a missing case |
| A test that is weak or incomplete but claims no more than it checks | minor |
| A behaviour the spec asked for with no test at all | major |
| Incidental code with no test | minor. Code is incidental only if no acceptance criterion or spec requirement depends on it: an entry point, CLI, handler or wiring that implements a requirement is not incidental, however thin |
| A spec requirement contradicted as written, even when the PR discloses it | major (disclosure goes in "Why it matters"; it does not lower the severity) |
| A decision the spec left open, made sensibly and easy to reverse | minor |
| A deviation supported only by precedent, with no written rule | minor at most |

### Who acts on a finding

The report is read by the agent that wrote the PR, which will fix what it is told to fix,
and by the project's owner. The "Action" field tells them apart. Get it right: an agent
that acts on a question only the owner can answer is guessing a second time.

| Action | When | What happens next |
|---|---|---|
| `fix now` | The right outcome is settled by the spec, a documented rule or the code itself, and the fix lies within what the task allowed the PR to change. | The authoring agent fixes it. |
| `needs owner decision` | The fix depends on a choice the spec does not settle: two sources conflict, the spec left a behaviour open, or the finding questions a decision the agent made. Also a small, self-contained edit outside the task's scope that this PR is the natural place for (a doc line it made stale): the owner may allow it. Fill in the decision fields. | The owner answers on the PR; only then does the agent act. |
| `for the owner` | The gap is real and the PR exposes it, but the fix lies in a contract, shared file or pre-existing code that the task did not allow the PR to change (for example, outside the issue's owned paths), and is more than a small edit this PR could carry. Say in "Why it matters" why the PR could not fix it. Severity is capped at minor. | Nothing in this PR. It does not count toward the verdict. |
| `noticed` | Re-reviews only: the finding is in code unchanged since the last review, and it is not a blocker or major **behaviour defect** (see "Re-reviews"). | Listed for the owner as a possible follow-up. Nothing in this PR. It does not count toward the verdict. |

The authoring agent may correct facts in any file, but never changes rules (what agents or
contributors should do) in instruction files, skills, agent definitions, templates or CI
configuration. A finding whose fix would change such a rule is never `fix now`.

If part of a finding can be fixed now and part needs a decision, split it into two
findings.

### Re-reviews

A PR reviewed before gets reviewed again after fixes, and a fresh look at unchanged code
always finds something new. Without a limit the rounds never end: each one grades the whole
PR from scratch. So on a re-review, findings are weighed by where they are:

- **In changed code** (lines changed since the last reviewed commit, listed in
  `<RUN_DIR>/changed-lines.txt`): graded and actioned as usual. These are what the fixes and
  decisions produced.
- **In unchanged code**: only a blocker, or a major **behaviour defect** (the code gives a
  wrong result, misclassifies, crashes, loses or exposes data, or breaks a safety or
  security rule), is actioned as usual: it was missed before and still matters. Anything
  else there (test gaps, smells, conventions, wording, nits) gets the action `noticed`.

A finding is in changed code if any line it cites falls in the changed ranges.

### Things already settled

Do not reopen what an earlier round settled, unless it is a blocker or a major behaviour
defect:

- A decision settles the question it answered, and the neighbouring cases its options or
  the agent's response named.
- A suggested fix the agent followed is not reversed: a later round does not ask for the
  opposite of what an earlier round asked for.
- A nit the agent declined, with a reason, is not raised again.

### Suggestions and options

You draft them, because you hold the evidence; the verifier then settles them, with every
finding of every reviewer in view. Write them to be acted on by an agent that will check
your claim but should not have to redesign your fix:

- **A suggested fix is a direction, not a patch.** Say what should change and where, and
  name what already exists to use. Leave the exact code to the agent that fixes it.
- **Prefer the smallest fix that resolves the finding.** If a larger change would be
  better, say so in "Why it matters", not in the fix.
- **"Done when" makes the fix checkable** by the next review round without re-deriving the
  finding.
- **Options are real alternatives**, each something a reasonable owner might choose, with
  its consequence stated plainly. Do not pad the list with options nobody would take.
- **Recommend one.** The recommendation is advice, grounded in a source the owner can
  check; the owner decides. Prefer the option that stays within the issue's scope unless
  the spec requires more, and offer anything beyond it as a follow-up issue. On a
  re-review, do not recommend new behaviour, or a refactor of code that already works and
  is tested, unless it fixes a defect. Do not cite the owner's answer to one question as
  their preference on a different one.
- **Fix the class, not the instance.** When the problem is a kind of mistake that may recur
  (one missing case among several similar ones), say so, and name the other places the PR
  has the same pattern.
- **Do not plant the next finding.** Prefer fixes that the compiler or an existing check
  can enforce over new runtime checks, put a new test where tests of that subject already
  live, and write "Done when" as a condition ("a slot at 2:30 is not confirmed by '2 PM'"),
  not as a line number.

### Line numbers

Every `path:line` in your output, in findings and in every table, is a line of that file as
it is in `<RUN_DIR>/worktree` (the PR head), numbered from 1 as an editor shows it. Get it
with `grep -n` or by reading the file. **Never cite a position in `diff.patch`**: the diff
is for seeing what changed, not for locating code. Use the full path from the repository
root. A script checks every citation against the files after verification.

### Rules for a valid finding

- The quoted code exists at the stated location in `<RUN_DIR>/worktree`.
- The "Measured against" quote exists at the stated source. If the measure is a precedent
  rather than a written rule, cite at least two existing places in the codebase that follow
  it, and cap the severity at minor.
- A personal preference with no rule, spec clause or precedent behind it is not a finding.
- Anything the manifest lists as machine-enforced (lint, format, types, CI checks) is not a
  finding. CI will report it.
- Problems that already existed and that the PR neither worsened nor relied on are out of
  scope.

## 2. Coverage ledger

This is the evidence of what you did. Record checks that passed as carefully as the ones that
failed: the reader uses this section to decide how far to trust the review.

```markdown
### Sources read
| Source | Why |
|---|---|
| `AGENTS.md` | standards |
| `src/billing/invoice.ts` (full file) | changed file |

### Checks performed
| # | Check | Scope | Result |
|---|---|---|---|
| 1 | <what was checked, specific enough to repeat> | <files or rule> | pass / finding <ID> / not applicable |

### Searches run
| Query or command | Purpose | Hits |
|---|---|---|
| `grep -rn "formatCurrency" src/` | look for an existing equivalent of the new `toMoney` helper | 3 |
```

Some briefs require extra tables (spec alignment: `### Spec traceability` and `### Unrequested
changes`; test adequacy: `### Behaviour coverage`). They go at the end of section 1, under
exactly those headings. A script checks every output for its required headings, and an
incomplete one is sent back.

## 3. Not reviewed

List everything in your remit that you did not or could not check, with the reason: a file
too large to read fully, a spec that was not accessible, a rule too vague to test, generated
or vendored files skipped. Write `Nothing skipped.` if that is true.
