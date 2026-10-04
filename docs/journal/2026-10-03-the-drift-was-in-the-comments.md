# 2026-10-03 — No decision was reversed, but 98 details had drifted into review comments

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #123, PRD (v1.1), ADR-001, ADR-002, ADR-003, ADR-004, ADR-005, ADR-007, ADR-008, ADR-009, ADR-010, `docs/architecture.md`, `CLAUDE.md`, `docs/backlog.md`

## What happened

Halfway through M2, with 33 issues open, we checked whether the docs agents read first still describe the system they're building. Four read-only audits ran in parallel on `main` at `d0992c7`: the open issues, the PRD's 38 requirements, the ten ADRs with `architecture.md` and `CLAUDE.md`, and the open questions left in journals, PR "Deferred" sections and issue comments. Together they found 98 findings: 31 on issues, 26 on the PRD, 25 on the ADRs and their neighbours, and 16 open questions. Merging the overlaps left 18 decisions for Nick and about 60 mechanical fixes.

Nick answered the 18 in one pass. He took the auditors' recommendation on 17. On the other, how a failed staff email gets re-sent, he chose an operator script with an alarm over an automatic retry. Issue #123 then wrote all of it into the PRD, the ADRs, `architecture.md`, `CLAUDE.md` and the backlog map, with no behaviour change. The issue edits went in separately, through the REST API.

## Why we chose what we chose

- **Amend, don't supersede.** No ADR's core decision had been reversed. Each one still describes what's built: our own loop, SAM with split stacks, a single table with transactional bookings, Cognito with SRP, a streaming REST API, our own eval harness, and Converse as the only transport. So every fix is a dated amendment or an italic pointer, under the rule PR #112 set in `docs/adr/README.md`. Amendments added in this pass carry `(#123)` in their heading and cite the issue or PR that settled each detail.
- **Write down only what was decided.** Each PRD and ADR edit came from a finding's proposed text, adjusted to Nick's answers. Where a decision also shapes future work, such as the CI eval gate, the model-choice rule, or the E2E environment, the docs record the rule and the issues carry the work.

The spec left some choices open. These are the ones PR #124 made, and how its review settled them:

- **FR-010's measurement run.** Decision 6 said "#40's run against `dev`", and decision 17 moved #40's E2E suite to an `e2e` environment. #40 already reconciles the two (the suite runs on `e2e`, FR-010 is measured by a read-only run on `dev`), so FR-010 now names "a Playwright run on the deployed stack (#40)" and leaves the environment to #40. Nick chose that wording in the review.
- **The daily cap is FR-017, a Must.** The audit proposed the requirement without an ID. It got its own ID rather than a clause in NFR-004, because patients see it (a message, and no Retry) and FR-015 already refers to it. Nick kept it as FR-017, Must, in the review.
- **ADR-003 got an amendment, not in-place edits.** The audit proposed editing two body lines; an amendment with pointers keeps the original text, as the marking rule asks. The review found three ADRs (005, 007, 009) where we had still rewritten lines in place; they now follow the same rule, and ADR-009 has its own amendment.
- **ADR-008 got one 2026-10-03 amendment** for the gate, exit metrics, latency and cost, the matrix, the API-surface retirement and judge agreement, because those decisions change ADR-008 body lines the issue didn't name.
- **Traceability beyond the audit's list:** #27 under FR-010 (it shows a failed session call), #80 under FR-037 (it carries the API-surface retirement), and #41 under FR-041 and FR-050.
- **Rules kept in two places.** The gate, exit-metric, cost and retry rules are written out in both the PRD and the ADR amendments. Nick kept both copies in the review, so each document reads on its own; the price is editing both, and the review already caught one disagreement (the gate's profile), now fixed.
- **The backlog map shows open follow-ups only.** Closed M2-era issues such as #56, #57, #60 and #88 stay on GitHub; the map's intro now says so (Nick's choice in the review).

## What surprised us

- **The drift lived where agents don't read.** Most findings were decisions recorded only in a PR's owner-decision lines or an issue comment. Examples: the greeting is templated and shown whole; restore covers one login session; the daily cap is 50 turns and Retry isn't offered for it; clinic business is escalated but unrelated requests are declined. Each was right in the code and absent from the PRD, so the next agent reading FR-014 or FR-015 would have rebuilt the question from scratch.
- **One promise had no owner.** PRD §5 said a failed staff email "is retried separately (#88)", but #88 only reworded a tool description, and no issue built a retry. Every escalation from the deployed chat is stored as `FAILED` today, because the notifier (#35) isn't wired yet. The PRD now says a failed send raises an alarm and staff tooling re-sends it, which is a criterion on #35.
- **Stale model names outlived the entitlement denial.** FR-042, ADR-002 and ADR-008 still planned an Opus 5 / Sonnet 5 / Haiku matrix days after AWS refused both 5-series models. ADR-009 still granted the chat role `bedrock-mantle:CreateInference`, an action no role has had since ADR-010.
- **Two rules contradicted each other.** ADR-008 and FR-041 path-filtered the CI eval gate, while `CLAUDE.md` says required checks always report. The gate now always runs and passes without calling Bedrock when no agent path changed.
- **Twelve issues sat in `status:backlog` with every blocker closed,** so the task-workflow skill would never offer them.

## Evidence

- Counts: 98 findings (A 31, B 26, C 25, D 16) → 18 decisions + about 60 mechanical fixes. The PRD audit's status table: Met 2, Built 14, Partly 12, Not started 9, Deferred 1, out of 38 requirements.
- The deployed `sched-dev-*` stacks and the 14 SSM parameters under `/sched/dev` matched the templates on `main`.
- The traceability table (PRD §10) had no issue above #45. It now maps the follow-ups filed from reviews (#49–#122).
- The edits, each with its finding ID: PR #124, which closes #123.

## What's next

- Re-run the PRD and ADR audits at the M3 exit, when #34, #37 and #40 have landed the rules written down here.
- When a PR settles something the spec left open, update the PRD line or ADR in that PR, not only in the decision line.
