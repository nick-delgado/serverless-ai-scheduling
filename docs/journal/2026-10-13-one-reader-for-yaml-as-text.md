# 2026-10-13 — Five tests sliced YAML five ways; one reader now decides where a block ends

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #157, PR #255, #152, #72, PR #224, PR #229, #40, #137

## What happened

Five tests read a SAM template or a workflow file as text, and each cut its YAML up its own way: `api-template.test.ts` by `indexOf` and a hand-written section reader, `ses.test.ts` by one regex per block, `web-template.test.ts` by an indented-block slicer, and `bootstrap-template.test.ts` and `eval-gate.test.ts` by fenced copies of that slicer, which also found a workflow step only when it was written `- uses:` first. PR #152's review flagged the copies; PRs #224 and #229 added the fourth and fifth on purpose, naming this issue as the place to merge them.

An agent (Claude, as #157's task worker) moved them into one module, `scripts/test/yaml-text.ts`: `block` (by header), `items` (a list's items, each whole whatever its first key), `entries` (a block's or an item's `key: value` pairs, a block scalar's value read as its body), `children`, `scalar` (a block scalar's dedented body), `bodyLines` (the comment-free body `api-template` compares exactly), `text`, and the credentials-step pattern and reader (`credentialsOf`). The five files now import it and define no slicer of their own, and each reports the same number of tests as before. A new test, `scripts/workflows.test.ts`, reads every workflow with an `aws-actions/configure-aws-credentials` step and pins its security settings (AC3), so #40's `e2e.yml` is checked the day it lands.

## Why we chose what we chose

- **Where a block ends (Nick, r1/Q-2 (b)).** A comment line never ends a block or an item, the way YAML reads it. The comment and blank lines just before the end are left out, since they introduce what follows. Lines inside a block scalar are body text, `#` or not. The old rule ended a block at a comment at its indent, and put the comment above a step (`evals.yml`'s "The secret reaches the script…") into the step before it.
- **A header must match exactly one line (r1/A-2).** A miss or a second match throws, which replaces `api-template`'s silent `""` and `[]`. A repeated header is looked up inside an enclosing block first. No current lookup needed rewriting.
- **Which later steps carry the credentials step's `if:` (Nick, r1/Q-1 (a)).** Every step after it in its job, with the same condition or `always() && <condition>`. No step is classed as calling AWS or not, so a new step can't slip past a list of patterns.
- **The agent's choices, where the spec left them open:**
  - `entries` reads an item's first key too, and a `run: |` value as its dedented body. That lets the tests read a step's `run:` and `if:` inside the step's item, not across the job. We rejected a separate `field` reader, because it would be a second way to read the same pairs.
  - A one-line value loses a trailing ` # comment`, so `uses: …@sha # v6.3.0` compares as the action and its SHA.
  - The credentials pattern (`CREDENTIALS_USES`, `isCredentialsStep`, `credentialsOf`) lives in the helper, the one place all three workflow tests can import it from. The duplicate check flagged the same eight lines in two of them before `credentialsOf` existed. The line count stays beside the item lookup (r1/A-10), so a credentials `uses:` that isn't a step's own key still fails.
  - `workflows.test.ts` picks its files by a line match, then checks them by items. A workflow whose step the item reader can't read is still picked, and then fails.
  - It treats `permissions: write-all` as granting `id-token: write`, since that is what GitHub does. A mutation row breaks it.

## What surprised us

- The fifth copy's step splitter was pinned to six spaces of indent (`/^ {6}- /`). The item reader takes the indent of the first item instead, and the same code reads `deploy.yml`'s steps and the helper's fixture.
- Comments in a template aren't only decoration. `SessionFunction`'s `Policies` holds two comment lines, and `bodyLines` must drop them for the exact list check to stay byte for byte. In a `run: |` body, a `# shellcheck` line is script and must stay. The reader can only tell the two apart by tracking where each block scalar starts and ends.

## Evidence

- Tests per file, before (`2e73ded`) and after (`901d182`), from Vitest's tree reporter: web-template 22 → 22, bootstrap-template 23 → 23, ses 21 → 21, api-template 8 → 8, eval-gate 56 → 56. New: `scripts/test/yaml-text.test.ts` 24, `scripts/workflows.test.ts` 9.
- Seen failing: the PR's `npm run mutate` table breaks the helper (the multiple-match refusal, the miss, a `- name:`-first item, each of Q-2's block ends, the dedent) and the templates and workflows: a second trust statement, a `- name:`-first credentials step left unmasked, a literal or `vars` role, `pull_request_target` in two `on:` forms, `id-token: write` at workflow level or in another job, a later step's `if:`, and one edit per migrated template test.

## What's next

- #40's `e2e.yml` meets `workflows.test.ts` as soon as it exists: its steps after the credentials step need the credentials step's `if:`.
- A new case for a template or workflow test goes into `scripts/test/yaml-text.ts` with its own test (`sam-deploy` rule 9).
