# Exchange contracts

Every file that passes between the orchestrator, its subagents and the scripts, who writes
it, who reads it, what it must contain, and what checks it. A file that fails its check goes
back to whoever wrote it; nothing downstream reads a file that failed.

All files live in `RUN_DIR` (outside any checkout). Markdown is the exchange format: models
write it reliably and people can audit it. What makes it a contract is the fixed headings and
field names below, and the scripts that check them.

## Written by scripts

| File | Writer | Readers | Contents |
|---|---|---|---|
| `pr.json`, `files.json`, `commits.txt`, `diff.patch`, `ci.txt` | `get-pr.sh` | everyone | The PR, its files, its commits (with dates), its diff, its checks |
| `spec/issue-<n>.md` | `get-issue.sh` | reviewers, verifier, analyst | The task's own issue with all its comments; read to its end |
| `spec/background/issue-<n>.md` | `get-issue.sh --background` | reviewers, verifier | A linked issue (description and people's comments) or PR (description only), trimmed; searched, not read whole; the tracking issue is never saved |
| `previous/` (report, earlier rounds, responses, decisions) | `get-previous.sh` | verifier, analyst | Earlier review rounds on the PR |
| `changed-lines.txt`, `base-changes.txt` | `changed-lines.sh` | reviewers, verifier | The PR's own lines changed since the last review; the base branch's changes |
| `spec-moves.md`, `spec-moves.patch` | `spec-moves.sh` | orchestrator (manifest), verifier, `assemble-report.sh` | Readiness state of the PR's issues; direction-document changes on the base branch since the work began and since readiness |
| `related-issues.md` | `related-issues.sh` | verifier | Open issues naming files the PR changes or linked from its issues, with their criteria, owned paths and decisions |
| `report.md`, `report-NN.md`, `process.md`, `findings.json` | `assemble-report.sh` | `post-report.sh`, `post-process-findings.sh`, `improve-agent-process` | The report (in comment-sized parts), the process findings (data line: round, changed lines, work began, harness version, readiness, cost), one JSON object per confirmed finding (with `failure_class`, `spec_moved`, `readiness`) |
| `progress.txt` | the orchestrator | the orchestrator, on resume; `assemble-report.sh` (cost lines) | PR, head, mode, harness version, finished phases, `cost=<phase>:<subagent>:<tokens>:<seconds>` lines, what was posted |

## Written by people or agents, and checked

| File | Writer | Readers | Required | Check |
|---|---|---|---|---|
| `manifest.md` | orchestrator (phase 3) | every subagent | Sections `## 1.` to `## 8.` (PR facts, spec sources, standards sources, agent process inventory, machine-enforced rules, gaps, previous review, tracked failure classes); "none" under an empty one; facts only | `validate.sh <run> manifest` |
| `findings/<name>.md` or `findings/<name>--<k>.md` | each reviewer (phase 4) | verifier, analyst | The three sections of `finding-schema.md`, plus the brief's required tables; part k's IDs from k×100+1; each spec file listed under "Sources read" as read to its last line (the spec-alignment reviewer lists all of them) | `validate.sh <run> reviewers` |
| `verified.md` | verifier (phase 5) | assembly script, analyst, fixing agent (through the report) | The sections in the verifier's brief; per confirmed finding: Severity, Action, Location; Decision needed, two or more options and a Recommendation for "needs owner decision", Suggested fix and Done when otherwise; "Changed since the last review" on a re-review; `needs owner decision` for a finding with "Spec moved" or a "Defer to #N" option, and no deferred blocker; a valid Action in every minor-table row; every `file:line` resolving to a line of a file at the PR head | `validate.sh <run> verified` |
| `root-cause.md` | root-cause analyst (phase 6) | assembly script, `improve-agent-process` (through the tracking issue) | The five sections of its brief; per cause-summary row: a valid severity and a failure class from the tracked list | `validate.sh <run> root-cause` |
| `report-head.md` | orchestrator (phase 7) | assembly script | The verdict line, the PR line, the lines `<!-- summary -->` and `<!-- counts -->` left as they are, the links | the assembly script |
| `report-meta.md` | orchestrator (phase 7) | assembly script | The run metadata of the report template | the assembly script |

## Comments on GitHub

| Comment | Writer | First line | Check |
|---|---|---|---|
| Review report (one per run, possibly in parts) | `post-report.sh` | `<!-- agent-pr-review:report sha=<commit> run=<id> part=<k>/<n> -->` | `post-report.sh` |
| Process findings (one per round, on the tracking issue) | `post-process-findings.sh` | `<!-- agent-pr-review:process pr=<n> sha=<commit> -->`, then a data line | `post-process-findings.sh` |
| Fixing agent's response | `address-pr-review` | `<!-- agent-pr-review:response review=<commit> head=<commit> -->` | its `post-response.sh` |
| Owner decision | the owner | `Decision <commit>/<ID>: <answer>` lines | `get-decisions.sh` |
| Deferral note (on the target issue) | `address-pr-review` | `<!-- agent-pr-review:deferred pr=<n> review=<commit> finding=<ID> -->` | its `post-deferral.sh` |

## Changing a contract

Change the producer's instructions, this table and the check together, in one release, and
bump the harness version: a resumed run started under another version starts clean.
