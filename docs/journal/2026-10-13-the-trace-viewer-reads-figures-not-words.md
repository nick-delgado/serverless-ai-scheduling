# 2026-10-13 — The trace viewer prints figures, not words, and can't read the messages next to the traces

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #38 (AC8, part 1 of 2), PR #261, FR-051, ADR-009, ADR-004

## What happened

The chat handler saves a `TurnTrace` to DynamoDB for every turn it runs: each model call's timing, stop reason and token use, and each tool call's name, result and duration. Until now nothing in the repo read the stored traces back. #38's last criterion asks for `scripts/trace.ts <conversationId>`, which prints a conversation's traces turn by turn. Nick split #38 into two PRs on its readiness review's advice. This is the first one: the viewer alone. Powertools, the dashboard and the other criteria come in the second.

A task-worker agent built it to Nick's answer to the readiness review's Q-7, option (a): `npx tsx scripts/trace.ts <env> <conversationId> [--table <name>] [--json] [--inputs]`. The table name comes from SSM unless `--table` is given. One line per turn shows its ID, start time and outcome. A second line shows the profile, prompt version, iterations, duration and usage. Then each model call gets a line (model ID, stop reason, TTFT, duration, usage) and so does each tool call (name, ok or the error code, duration). `--json` prints one object per turn with the same fields. A conversation with no traces exits 1 with a note on stderr. An item that doesn't parse as a `TurnTrace` is named as unreadable, and the script exits 1 once the rest have printed.

## Why we chose what we chose

Nick's answer to Q-7 (a) settled the main shape: read only the `TRACE#` items under the conversation and never its messages, print IDs and figures, and print no patient ID. The readiness review's reuse note settled where the key prefixes come from: `turnKeys`, imported through a new `@sched/api/dynamo-turn-store` subpath export, so a copy of `"CONV#"` and `"TRACE#"` can't drift from the store. The script asks `turnKeys` for an empty turn ID's key, and the query uses `begins_with(SK, "TRACE#")`. A test on DynamoDB Local puts a message item in the same partition and checks that its text never reaches the output.

The spec left these open, and the agent settled them:

- **The patient ID never leaves the table.** Each trace item stores the `patientId` beside the trace, and the query's projection is `SK, startedAt, trace`. The alternative was to read the whole item and leave the field out when printing, which would still carry it over the wire and through the script's memory.
- **The env check is the one the other scripts use.** `seed-data.ts` now exports its `ENV_PATTERN`, and `retry-escalations.ts` imports it in place of its own copy. The alternative was a fourth TypeScript copy of the regex, after `seed-data.ts`, `retry-escalations.ts` and `seed-users.ts`. Nick approved both edits on the PR (`e36f1d2/STD-1` (a)).
- **The conversation ID is checked too.** It must be a UUID, as `ConversationId` says, so a typo exits 1 with "invalid conversationId" before any AWS call. The alternative was to query with the raw argument and end on "No traces". Nick kept the check on the PR (`e36f1d2/SPEC-2` (a)).
- **The order is the trace's own `startedAt`.** When the trace doesn't parse, the item's stored `startedAt` places it, and an item with neither sorts first. The alternatives were to put unreadable items last, or to leave every item in key order, which is random (see below).
- **An unreadable item is named on stderr.** That keeps stdout one JSON object per turn under `--json`. The alternative was a placeholder object on stdout.
- **Two extra figures print.** Each model call shows its index and attempt, and the provider's own stop reason when it differs from the neutral one. Both are IDs or codes, within ADR-009. The alternative was the bare list from Q-7, which can't tell a retried call from the next step.

## What surprised us

- **DynamoDB returns the traces in random order.** The sort key is `TRACE#<turnId>`, and turn IDs are random v4 UUIDs, so a query hands them back in an order that has nothing to do with time. Without the sort the output only looks right when the IDs happen to fall in time order. The tests make the earlier turn's ID sort after the later one's, so a missing sort fails them instead of passing by luck.
- **The coverage gate passes on empty coverage.** We first ran it after `vitest run --coverage --project scripts`, which wrote an empty coverage map (`{}`). `coverage:changed` reported "every added source line since origin/main ran in a test". A file that's missing from the map counts as having no uncovered lines (`scripts/coverage-changed.ts:170-171`). CI runs the whole suite, so the map there is complete. A partial local run, though, can pass the gate without having checked anything. The full run then found five uncovered lines: the CLI entry block, which now has an ignore hint with a reason, and a catch arm, which now has a test.

## Evidence

- `scripts/trace.ts`, `scripts/trace.test.ts`. The DynamoDB Local tests save traces through `createDynamoTurnStore`, the chat handler's own store, so the viewer reads exactly what the handler writes.
- Seen failing: the `npm run mutate -- … --markdown` tables in the PR body.
- A read-only run against `dev` as `sched-dev`, on a conversation from 2026-10-10 with three traced turns: exit 0, 16 lines, the turns in time order. DynamoDB's key order would have put the first turn last (its turn ID starts `a6a2…`, the other two `19c5…` and `3e6d…`). The first turn shows three model calls (TTFT 1363, 790 and 756 ms) and a `check_availability` call that failed `INVALID_INPUT` before a retry succeeded. An all-zero conversation ID printed "No traces" and exited 1.

## What's next

- #38's second PR: Powertools logging, metrics and tracing, the dashboard, the conflict-retry metric and the notification-status report.
- Operator documentation for the script belongs in `docs/runbooks/` beside `retry-escalations.ts`. That's #42's path. **Later (2026-10-16):** `aws-setup.md` has "Appendix: reading a conversation's agent traces", and the three scripts share one table lookup; see [A new env from the runbook alone](2026-10-16-a-new-env-from-the-runbook-alone.md).
