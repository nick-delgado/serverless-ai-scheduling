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
- **Suggested fix:** <what to change; name the existing function, pattern or doc to use>
- **Introduced by this PR:** yes | worsened | pre-existing (only report pre-existing when the PR depended on it)
- **Action:** fix now | needs owner decision | for the owner (see "Who acts on a finding")
- **Decision needed:** <only for "needs owner decision": the question, and the options with what each would change>
```

IDs use the reviewer's prefix and a running number: `STD-1`, `SMELL-1`, `SPEC-1`, `TEST-1`.

### Severity

| Level | Meaning |
|---|---|
| blocker | Must not merge: contradicts the spec or a documented hard rule, breaks an architectural boundary, removes or disables verification, or ships placeholder behaviour as real. |
| major | Should be fixed before merge: a clear violation of a documented standard, a missing requirement, duplicated logic that will drift, behaviour without a meaningful test. |
| minor | Worth fixing, safe to merge without: local maintainability issues, weak but present tests, small unrequested changes. |
| nit | Optional polish. Report at most five per reviewer. |

Boundary cases, decided here so that every reviewer and the verifier grade them the same
way:

| Case | Severity |
|---|---|
| A test whose name, or the PR description, claims it covers something the test cannot detect | major (the claim is what makes it major: a reader will trust it) |
| A test that is weak or incomplete but claims no more than it checks | minor |
| A behaviour the spec asked for with no test at all | major |
| Incidental code with no test | minor |
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
| `needs owner decision` | The fix depends on a choice the spec does not settle: two sources conflict, the spec left a behaviour open, or the finding questions a decision the agent made. Fill in "Decision needed". | The owner answers on the PR; only then does the agent act. |
| `for the owner` | The gap is real and the PR exposes it, but the fix lies in a contract, shared file or pre-existing code that the task did not allow the PR to change (for example, outside the issue's owned paths). Say in "Why it matters" why the PR could not fix it. Severity is capped at minor. | Nothing in this PR. It does not count toward the verdict. |

If part of a finding can be fixed now and part needs a decision, split it into two
findings.

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

## 3. Not reviewed

List everything in your remit that you did not or could not check, with the reason: a file
too large to read fully, a spec that was not accessible, a rule too vague to test, generated
or vendored files skipped. Write `Nothing skipped.` if that is true.
