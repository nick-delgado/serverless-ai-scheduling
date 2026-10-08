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

**PR:** #<n> <title> · **Reviewed commit:** [`<short sha>`](<PR URL>/commits/<full sha>) · **CI:** <passing | failing: names | pending | none> · **Spec:** <issue #m (link) | path/to/spec.md | none found>

<!-- summary -->

<!-- counts -->

(Leave those two lines exactly as they are: the assembly script replaces the first with the
verifier's summary, and the second with the counts table and the "By action" line, computed
from `verified.md`, including a Verifier row for `VER-` findings. Do not write your own.)

<On a re-review:> Round <k>. Previous review of `<sha>`: <n> resolved, <n> still present, <n> decided, <n> for the owner, <n> withdrawn. This round: <n> blocking findings in changed code and <n> in unchanged code, against <n> confirmed last round.

<If any owner decision added scope beyond the issue:> Added by owner decisions so far: <the decisions, as `<commit>/<ID>`, and what each added>.

Why these issues arose, and proposed changes to the project's agent setup: <URL of the tracking-issue comment, or "not analysed (no findings above nit)">
```

The verdict is still yours to write, from the verdict table below and the computed counts.

### `RUN_DIR/report-meta.md`

```markdown
- Reviewed commit: `<full head sha>` against `<base ref>`
- Reviewing agent and model: <tool, model>
- Reviewers: standards, code-smells, spec-alignment, test-adequacy; verifier; root-cause analyst
- Isolation: <parallel subagents with fresh context | none (sequential, shared context)>
- Tests, linters and builds were not run by this review; CI status is reported as found.
- Line citations: <the summary line from check-citations.sh>
- Harness version: <`metadata.harness-version` from the frontmatter of the review-agent-pr SKILL.md that ran>
- Cost: added by the assembly script after these lines: a table of each subagent's phase, model, effort, tokens and time, and the hidden run record. Do not write it here.
- Spec moves and related issues: <the two summary lines from spec-moves.sh, and the count from related-issues.sh>
- <Anything that did not complete: a reviewer that failed, a phase skipped, and why.>
```

## Verdict

| Verdict | When |
|---|---|
| **Changes required** | any confirmed blocker |
| **Changes recommended** | no blocker, at least one confirmed major |
| **Acceptable** | only minor findings and nits, or none |

Findings whose action is `for the owner` or `noticed` do not count toward the verdict.
Findings that need the owner's decision do.

**The stopping rule.** On a re-review, `noticed` findings never block, so the verdict
depends only on changed code and on serious defects anywhere. When a re-review finds no
blocker, no major in changed code and no major behaviour defect in unchanged code, the
verdict is **Acceptable**, and the remaining minors, nits and noticed items are follow-ups,
not a reason for another round. Say so in the summary: "No further review round is
needed."

Add `— limited review` to the verdict when spec alignment was not reviewable or a reviewer
could not complete. The verdict is a recommendation to the human who merges.

## What the script assembles

### The report (`assemble-report.sh <RUN_DIR> report <full head sha>`, written to `report-01.md`, `report-02.md`, ...)

| Section | Taken from |
|---|---|
| Header, summary, counts, link to the process findings | `report-head.md` |
| Fix now | `verified.md`: confirmed findings and minor-table rows whose action is `fix now` |
| Needs the owner's decision | the same, for `needs owner decision` |
| For the owner (no action in this PR) | the same, for `for the owner` |
| Noticed in unchanged code (re-review only, not blocking) | minor-table rows whose action is `noticed` |
| Convergence (re-review only) | `verified.md` → Convergence |
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

GitHub limits a comment to 65,536 characters. Nothing in the report is trimmed to fit:

- **The report** is split into as many comments as it needs, each under 60,000 characters.
  It splits only between units: a section, a finding, a collapsed `<details>` block, or the
  minor-findings table. A part that starts inside a section repeats the section heading
  with "(continued)". A unit too large for one comment on its own (a very long table) is
  split between lines, repeating the table's header and reopening its `<details>` block.
- **Each part's first line** is `<!-- agent-pr-review:report sha=<reviewed commit>
  run=<run id> part=<k>/<n> -->`. Part 1 says the review is in n parts; every later part
  starts with "Agent PR review of `<sha>`: part k of n"; every part but the last ends with
  "Continued in part k+1 of n". The scripts that read reports (`get-reports.sh`, used by
  `get-review.sh` and `get-previous.sh`) join the parts of a run in order, and skip a
  report with a part missing, with a warning.
- **The process findings** must fit in one comment. If they do not, the script fails and
  prints the size of each section: shorten the proposals in `root-cause.md` (see the
  analyst's length rules) and run it again.
