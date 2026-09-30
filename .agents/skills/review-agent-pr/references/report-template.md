# Output layout

A review has two outputs, for two readers.

| Output | Where | Reader | Holds |
|---|---|---|---|
| The report | One comment on the PR | The agent that will fix the PR, and the person who merges it | The verdict, the code findings grouped by who acts on them, spec alignment, evidence of review |
| Process findings | One comment per reviewed PR on the tracking issue labelled `agent-process` | The owner of the project's agent setup | The inferred cause of each finding, patterns, proposals |

`scripts/assemble-report.sh` builds both from the phase outputs, unchanged. You write two
small files for the report.

## What you write

### `RUN_DIR/report-head.md`

```markdown
## Agent PR review: <verdict>

**PR:** #<n> <title> · **Head:** `<short sha>` · **CI:** <passing | failing: names | pending | none> · **Spec:** <issue #m (link) | path/to/spec.md | none found>

<Two or three sentences: what the PR does and the most important problems. Code only: say
nothing here about causes or process.>

Confirmed findings after verification (<reported> reported, <confirmed> confirmed, <merged> merged, <rejected> rejected):

| | Blocker | Major | Minor | Nit |
|---|---|---|---|---|
| Standards | | | | |
| Code smells | | | | |
| Spec alignment | | | | |
| Test adequacy | | | | |

By action: <n> to fix now, <n> waiting for the owner's decision, <n> for the owner.

<On a re-review:> Previous review of `<sha>`: <n> resolved, <n> still present, <n> decided, <n> for the owner, <n> withdrawn.

Why these issues arose, and proposed changes to the project's agent setup: <URL of the tracking-issue comment, or "not analysed (no findings above nit)">
```

Count each confirmed finding under the reviewer whose ID it kept. Take the numbers from
the verification summary in `verified.md`; do not recount by hand.

### `RUN_DIR/report-meta.md`

```markdown
- Reviewed commit: `<full head sha>` against `<base ref>`
- Reviewing agent and model: <tool, model>
- Reviewers: standards, code-smells, spec-alignment, test-adequacy; verifier; root-cause analyst
- Isolation: <parallel subagents with fresh context | none (sequential, shared context)>
- Tests, linters and builds were not run by this review; CI status is reported as found.
- Line citations: <the summary line from check-citations.sh>
- <Anything that did not complete: a reviewer that failed, a phase skipped, and why.>
```

## Verdict

| Verdict | When |
|---|---|
| **Changes required** | any confirmed blocker |
| **Changes recommended** | no blocker, at least one confirmed major |
| **Acceptable** | only minor findings and nits, or none |

Findings whose action is `for the owner` do not count toward the verdict. Findings that
need the owner's decision do.

Add `— limited review` to the verdict when spec alignment was not reviewable or a reviewer
could not complete. The verdict is a recommendation to the human who merges.

## What the script assembles

### The report (`assemble-report.sh <RUN_DIR> report`)

| Section | Taken from |
|---|---|
| Header, summary, counts, link to the process findings | `report-head.md` |
| Fix now | `verified.md`: confirmed findings and minor-table rows whose action is `fix now` |
| Needs the owner's decision | the same, for `needs owner decision` |
| For the owner (no action in this PR) | the same, for `for the owner` |
| Previous findings (re-review only) | `verified.md` → Previous findings |
| Spec alignment (traceability, unrequested changes) | `verified.md` → Reviewer tables |
| Evidence of review: counts of checks, searches and skipped items per reviewer | `findings/*.md` |
| Not reviewed (collapsed, always in full) | `findings/*.md` → 3. Not reviewed |
| Findings rejected or merged in verification (collapsed, always in full) | `verified.md` |
| Passed checks re-checked by the verifier (collapsed, always in full) | `verified.md` → Spot checks |
| Every check performed (collapsed, only when it fits) | `findings/*.md`, `verified.md` → Behaviour coverage |
| Run metadata (collapsed) | `report-meta.md` |

In each of the three groups, blockers and majors appear as full blocks and minors and nits
as table rows. The three group headings are fixed: the `address-pr-review` skill finds its
work by them.

### Process findings (`assemble-report.sh <RUN_DIR> process <n> <head-sha>`)

| Section | Taken from |
|---|---|
| Causes (one line per finding), patterns, not explained | `root-cause.md` → Cause summary, Patterns, Not explained |
| Proposals | `root-cause.md` → Proposals |

## Length

GitHub limits a comment to 65,536 characters. The script keeps each output under 60,000:

1. It builds the report with the full check tables.
2. If that is too long, it leaves the check tables out and says so in the run metadata. The
   per-reviewer counts, the "Not reviewed" list and the rejected findings always stay.
3. If an output is still too long, it fails and prints the size of each section. Shorten
   the largest section in its source file and run it again. Never shorten blocker or major
   findings, the "Not reviewed" list, or the rejected findings.
