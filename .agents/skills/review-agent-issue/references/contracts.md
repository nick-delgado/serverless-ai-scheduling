# Exchange contracts

Every file that passes between the orchestrator, its subagents and the scripts, who writes
it, who reads it, what it must contain, and what checks it. A file that fails its check goes
back to whoever wrote it; nothing downstream reads a file that failed.

All files live in `RUN_DIR` (outside any checkout).

## Written by scripts

| File | Writer | Readers | Contents |
|---|---|---|---|
| `spec/issue-<n>.md` | `get-issue.sh` | analysts, verifier | An issue with all its comments |
| `issue-body.md`, `previous/round-<k>.md`, `previous/applied-<k>.md` | `get-readiness.sh` | verifier, refresh analyst, `apply-readiness.sh`, `update-issue-body.sh` | The description as it is now; earlier rounds and apply records |
| `spec-changes.patch` | the orchestrator (`git diff`, refresh mode) | refresh analyst | The direction documents' changes since the last round's spec commit |
| `issue-body.new.md`, `applied.md` | `apply-readiness.sh` | `update-issue-body.sh`, `post-readiness.sh` | The new description; the record of what was applied, ending in what is still open |

## Written by people or agents, and checked

| File | Writer | Readers | Required | Check |
|---|---|---|---|---|
| `manifest.md` | orchestrator | every subagent | Sections `## 1.` to `## 6.`; the full spec commit | `validate.sh <run> manifest` |
| `analysis/spec.md` | spec analyst | verifier | The sections of its brief's output; every file under `spec/` listed under "Sources read" as read to its last line | `validate.sh <run> analysis` |
| `analysis/code.md` | codebase scout | verifier | The sections of its brief's output, including "Lines made stale" | `validate.sh <run> analysis` |
| `readiness.md` | verifier, or refresh analyst | the owner, `apply-readiness.sh`, later the coding agent and PR reviewer | The first line and heading of `readiness-format.md`; the data line with the full spec commit; "Check these first" and "Relied on"; per question two or more options (one per line, each with a Scope label), a Recommendation and a Reply line; per assumption all five columns; no reuse by likeness; each edit's "Before" text verbatim in `issue-body.md` | `validate.sh <run> readiness` |

## Comments on GitHub

| Comment | Writer | First line | Check |
|---|---|---|---|
| Readiness review (one per round) | `post-readiness.sh` | `<!-- agent-pr-review:readiness round=<k> -->` | `post-readiness.sh` |
| Apply record (one per apply) | `post-readiness.sh`, from `applied.md` | `<!-- agent-pr-review:readiness-applied round=<k> -->` | `post-readiness.sh` |
| Deferral note (work deferred to this issue from a PR review) | `address-pr-review` | `<!-- agent-pr-review:deferred pr=<n> review=<commit> finding=<ID> -->` | its `post-deferral.sh`; read by the spec analyst and refresh mode |
| Owner's answers | the owner | `Decision r<k>/<ID>: <answer>` lines, ID being `Q-<m>`, `A-<m>`, `E-<m>` or `ALL` | `get-issue-decisions.sh` |

## Changing a contract

Change the producer's instructions, this table and the check together, in one release, and
bump the harness version.
