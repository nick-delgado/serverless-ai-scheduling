---
name: task-workflow
description: >-
  The end-to-end workflow for doing a backlog task in this repo. It covers: finding an
  unblocked GitHub issue, claiming it so parallel agents don't collide, working in an
  isolated git worktree, staying inside the issue's owned paths, meeting the CLAUDE.md
  definition of done, opening a PR that closes the issue, and handing off (journal note,
  status labels). Use it whenever you start, resume, or finish work on an issue or task,
  e.g. "pick up the next task", "work on #23", "start S4-03", "what can I work on?",
  "you're the agent for the tools stream", "open a PR for this", "I'm blocked". Use it
  even when the user doesn't mention GitHub or issues but is clearly asking you to build
  a backlog item.
---

# Task workflow

This repo is built by several AI agents working in parallel on GitHub issues. The workflow exists so that:
- no two agents work on the same thing;
- nobody edits files another stream owns;
- every change is traceable from PRD requirement → issue → PR → journal.

Follow the steps in order. Each one explains why it matters, so you can adapt when something doesn't fit.

## 1. Find work that's actually ready

```bash
gh issue list --state open --label "status:ready" --search "no:assignee" \
  --json number,title,labels,milestone --limit 50
```

- If the user named an issue or stream, use that.
- Otherwise prefer the **lowest open milestone** (M1 before M2), then the stream you were assigned.

Before claiming, **check the blockers.** An issue is ready only when every issue it depends on is closed:

```bash
gh api "repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by" --jq '.[] | "\(.number) \(.state) \(.title)"'
gh issue view <N> --json body --jq .body | sed -n '/## Dependencies/,/^## /p'   # the body lists them too
```

If a blocker is still open, pick something else and tell the user why. Working ahead on an unmerged dependency is how parallel agents create conflicting versions of the same interface.

## 2. Claim it visibly

```bash
gh issue edit <N> --add-assignee @me --add-label "status:in-progress" --remove-label "status:ready"
gh issue comment <N> --body "Claimed. Working on branch \`<branch>\`. I'll update here if I get blocked."
```

If the issue is already assigned or `status:in-progress`, don't take it over. Pick another and mention it. Other agents rely on this signal.

## 3. Work in an isolated worktree

- Branch name: `<type>/<issue#>-<short-slug>`, where `type` is one of `feat`, `fix`, `infra`, `spike`, `docs`, `eval`, `chore`. Example: `feat/23-book-appointment-tool`.

```bash
git fetch origin
git worktree add ".worktrees/<issue#>-<slug>" -b "<branch>" origin/main
cd ".worktrees/<issue#>-<slug>" && npm ci
```

Worktrees let several agents build and test at the same time without stepping on each other's working directories. Keep them **inside the repo under `.worktrees/`**, which is git-ignored and excluded from lint and tests. Claude Code's file tools (Read/Edit/Write) only work inside the project directory, so a worktree at `../something` can be reached by shell commands but not edited normally.

## 4. Read before you write

1. **The issue body.** The goal, acceptance criteria, **owned paths**, dependencies, and verification commands form the contract for this task. An item under "Decisions and clarifications", or an owner decision on the PR (`Decision <commit>/<ID>: ...`), is Nick's answer: build it exactly as written, even when nearby code, an example or a check seems to disagree, and raise any doubt under the PR's "Departs from or questions an owner decision" rather than choosing your own reading.
2. **`CLAUDE.md`.** Especially the architecture rules:
   - patient ID only from the JWT;
   - atomic bookings;
   - injected dependencies;
   - append-only history.
3. **The ADRs and PRD requirements the issue cites.** If the issue conflicts with an ADR, the PRD, `packages/contracts` or a skill, stop and ask. Don't silently pick one. If you can't ask, take the reading that satisfies both, and list it with the decisions the spec left open (in the journal entry, which the PR's "Decisions the spec left open" links).

## 5. Implement inside your owned paths

- Only modify the paths the issue lists. Shared files (root `package.json`, `tsconfig`, `packages/contracts`) sometimes need small edits. Keep those minimal and **call them out in the PR**. A schema change in `packages/contracts` affects every stream.
- If the work clearly needs files outside your paths, or beyond a limit the issue puts on a path ("fixtures only"), comment on the issue and ask the user instead of expanding scope. If you can't ask (a delegated task worker), make the smallest change that meets the criterion and list it under "Shared-file or contract changes", naming the criterion that needs it, for the owner to approve.
- Before adding a constant, type, schema or helper, search for an existing one (`git grep`) and import it. If it lives where you can't import it, prefer the smallest disclosed edit that shares it (an export) to a copy. If you do copy, list each copy and its source under "Shared-file or contract changes".
- After merging or rebasing on `main`, read what landed (merged PRs, new journal entries, sibling handler headers) and bring your code, tests, stand-ins and PR description in line, even where no test broke. Do the same when a decision, or the work itself, lands in your own PR (a PRD edit, a changed message or rule, a step that was pending): search for the old wording, and run `git grep -n '#<N>\b'` for lines that still call your issue planned or pending. Edit every restatement (journal entry, code comments, docs, diagrams), and list the ones outside your paths under "Shared-file or contract changes".
- Commit in small, meaningful steps using Conventional Commits that reference the issue, e.g. `feat(tools): add book_appointment transaction (#23)`. End commit messages with the attribution lines from the session's system reminder, if there are any.

## 6. Prove it's done

Run the issue's verification commands, then the CLAUDE.md **definition of done**:

- [ ] Every acceptance criterion is met (check each one explicitly).
- [ ] `npm run lint && npm run typecheck && npm test` passes.
- [ ] Seen failing: `npm run mutate` with `expect`, and its `--markdown` table in the PR body (the `Seen-failing evidence` check).
- [ ] If you touched the agent, prompts, tools, or model config: the smoke suite in both modes (`npm run evals -- --suite smoke --mode l1` and `--mode scenario`, the `run-evals` skill) shows no regression against `packages/evals/baselines/sonnet-4.6.json`, or one the owner accepted (`CLAUDE.md`). The PR's `Eval gate` check runs the same comparison. Put the numbers in the PR.
- [ ] If you touched infra: `sam validate --lint` passes, and it's deployed to `dev` (or the PR says why not).
- [ ] Docs: an ADR for any new or changed significant technical decision, PRD traceability if requirements moved, and a journal entry if something was story-worthy or you decided something the spec left open (see step 8).
- [ ] No secrets, real PII, or credentials anywhere in the diff.

If something fails and you can't fix it within scope, report what failed, with the output. Don't open a PR that claims success.

## 7. Open the PR

Pushing and opening a PR is the normal end of a task. If the user hasn't said in this session that you may push, confirm with them first.

```bash
git push -u origin "<branch>"
gh pr create --base main --title "<type>(<scope>): <summary> (#<N>)" --body-file <tmp-body.md>
```

Use `.github/pull_request_template.md`. The body must include:
- `Closes #<N>`. It stays even when a criterion needs a step you can't run (a write to `dev`, a live measurement, a browser check, an eval run a rule you were given blocks): mark that step pending in the PR, where its result will go, and report it. It's done before merge;
- the PRD requirement IDs covered;
- how you verified it (commands and results, eval numbers);
- any shared-file or contract changes;
- anything deferred.

End it with the PR attribution line from the session's system reminder, if there is one.

Then update the labels:

```bash
gh issue edit <N> --add-label "status:review" --remove-label "status:in-progress"
```

If the PR adds a journal entry, add `PR #<number>` to its **Related** line now, then commit and push. The `Journal links` check fails until you do.

## 8. Hand off

- **Journal-worthy?** Write an entry with the `dev-journal` skill if any of these happened:
  - you made or reversed a decision;
  - a spike produced numbers;
  - an eval result moved;
  - something broke in a surprising way;
  - you found a better approach than the issue assumed.
  Put the entry in the same PR.
- **Blocked?** Don't just stop. Label it, and say exactly what's needed and from whom:

  ```bash
  gh issue edit <N> --add-label "status:blocked" --remove-label "status:in-progress"
  gh issue comment <N> --body "Blocked: <what>, <who can unblock>, <what I tried>."
  ```

- **After merge:** promote any issues this one unblocked. They're listed under "Unblocks" in the issue body. A dependent becomes `status:ready` only when **all** of its blockers are closed:

  ```bash
  gh api "repos/{owner}/{repo}/issues/<dependent>/dependencies/blocked_by" --jq '[.[] | select(.state=="open")] | length'
  # 0 open blockers →
  gh issue edit <dependent> --add-label "status:ready" --remove-label "status:backlog"
  ```

  Then run `git worktree remove ".worktrees/<issue#>-<slug>"` and delete the branch. This keeps the ready queue accurate for the next agent.

## Label reference

| Label | Meaning |
|---|---|
| `status:backlog` | Has open blockers; not claimable yet |
| `status:ready` | All blockers closed; free to claim |
| `status:in-progress` | Claimed; someone is working on it |
| `status:blocked` | Waiting on something; see the latest comment |
| `status:review` | PR open |
| `stream:*` | Owning work stream (e.g., `stream:tools`, `stream:evals`) |
| `type:*` | `feature`, `spike`, `infra`, `eval`, `docs`, `chore` |
| `needs:human` | Nick must act (console, credentials, judgment). Agents prepare; they don't attempt it |

The dependency map and per-stream lanes are in `docs/backlog.md`.
