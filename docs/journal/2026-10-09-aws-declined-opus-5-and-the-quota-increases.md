# 2026-10-09 — AWS declined Opus 5, Sonnet 5 and the quota increases, so six profiles at 10 RPM are the plan, not a stopgap

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #227, PR #228, #49, #37, ADR-002, ADR-008, ADR-010, PRD FR-042

## What happened

Since spike S-1 (2026-09-28) the docs had carried two open requests to AWS. One asked AWS Support to enable Claude Opus 5 and Sonnet 5 on this account, which ADR-002 named as the target models. The other asked for higher on-demand quotas for the two Claude models we can call, Sonnet 4.6 and Haiku 4.5. Spike S-1b (#49) was parked in M3 to measure Opus 5 and Sonnet 5 once the first request came through.

AWS declined both. Nick checked on 2026-10-09: Opus 5 and Sonnet 5 are still not available to the account, and Sonnet 4.6 and Haiku 4.5 are both still at 10 requests per minute. Nick closed #49 as not planned the same day.

An agent then searched the repository for #49, S-1b and "quota increase" (the `git grep` under Evidence) and corrected the lines outside the journal that it found presenting either request as pending (#227): the PRD's risk table, milestone row and FR-042's traceability row, the backlog map's #49 node and rows, and ADR-002, which gets a dated amendment rather than a rewrite. The search doesn't reach one code comment, found in review: `spikes/s1-bedrock-tool-latency/run.ts` still says Opus 5 / Sonnet 5 "await AWS". It was left as written, because #227 changes no code.

## Why we chose what we chose

- **Six entitled profiles stand.** ADR-010 already moved the project to Converse and six entitled profiles (Sonnet 4.6, Haiku 4.5, Nova 2 Lite, Nova Pro, gpt-oss-120b, gpt-oss-20b), and ADR-008's 2026-10-03 amendment already took Opus 5 and Sonnet 5 out of the M3 matrix. The decline changes no code: `opus-5` and `sonnet-5` stay defined in `packages/agent/src/profiles.ts` and throw when resolved, and ADR-010's "Revisit if they become entitled" stays, because entitlement can still change later.
- **The 10 RPM limiter is the mitigation, not a stopgap.** ADR-008's per-model token bucket at 90% of each profile's `rpm` already paces every live call. The risk table used to pair it with "quota increase requested"; now it stands alone. The cost is wall-clock time on Claude eval runs, not correctness.
- **#49 leaves the traceability table rather than staying with a "closed" note.** The PRD table keeps closed issues that did their work (#33, #60); #49 never did any, so FR-042's row drops it. The backlog map, which keeps the history of what was planned, marks it closed, not planned.
- **ADR-002 gets pointers on four lines, not one.** The issue named the "Target models remain… S-1b" line; the throttling note ("probably a quota increase") and interim-path steps 1 and 3 (open a Support case, rerun when entitlement arrives) also read as pending, so each gets an italic pointer to the amendment. The alternative, leaving them because they sit in a dated proposal, would have left the grep showing open requests.

## What surprised us

How many places one pending request had spread to. "#49" or "S-1b" appeared in nine lines across three documents, and the PRD's risk table cited it for two different things: an entitlement spike in one row and a quota request in another.

## Evidence

- #49's closing comment: https://github.com/nick-delgado/serverless-ai-scheduling/issues/49#issuecomment-6079731817
- `git grep -n -E '#49([^0-9]|$)|issues/49|quota increase|S-1b' -- ':!docs/journal/'` after #227 prints 16 lines in `docs/PRD.md`, ADR-002 and `docs/backlog.md`, each a corrected line or the amendment itself. (The issue's `#49\b` matches nothing under `-E` on macOS git, where `\b` isn't a word boundary.)
- Quotas as built: `rpm` in `packages/agent/src/profiles.ts` (Claude profiles 10).

## What's next

- The M3 matrix (#37) picks the production profile among the six entitled ones, paced at 10 RPM for the Claude profiles.
