# Harness changes

Changes to the review harness itself (`review-agent-pr`, `address-pr-review`,
`review-agent-issue`, `improve-agent-process`), recorded like a project's batch rows so
they can be measured the same way. The harness's maintainers add a row for each change
that could move a count; `improve-agent-process` measures them (step 2), splitting the
reviews by the harness version on each data line instead of by when work began.

A target is a failure class, or a reviewer signal (step 3): `rejected` (share of reported
findings the verifier rejected), `overridden` (owner decisions against the
recommendation), `disputed-upheld` (disputes a later round agreed with), `fix-introduced`
(defects introduced by a suggested fix), `late-find` (findings in code an earlier round
passed), `rounds` (review rounds per PR), `cost` (tokens per review). `none` means the
change is mechanics that no count measures; it is listed so the record is complete.

A reviewer change can move a count either way: one that makes the reviewer see more (say,
reading the whole spec) raises its target's count in first reviews. Such rows say
"expected: up"; measure them against reviewer signals (`late-find`), and split project
measurements at their version.

| ID | Version | Change | Kind | Skill | Target |
|---|---|---|---|---|---|
| H1 | 2026.10.06 | Exchange contract: every hand-off validated; counts and findings.json written by script | guardrail | review-agent-pr, review-agent-issue | none |
| H2 | 2026.10.06 | Readiness answers applied by script from Decision lines only; `ALL` leaves the riskiest assumptions to explicit answers | guardrail | review-agent-issue | none (mechanics: how answers are applied, not whether they are right; was spec-deviation, spec-guess until 2026.10.08) |
| H3 | 2026.10.06 | Readiness format: designs the work must produce are questions; fewer, checkable assumptions; reuse as import / move and share / ask; one-story consistency pass | words | review-agent-issue | spec-guess, duplication |
| H4 | 2026.10.06 | Spec moves listed in the manifest; "Spec moved" findings classed `spec-moved` and left out of agent counts | guardrail | review-agent-pr | spec-deviation |
| H5 | 2026.10.06 | Related upcoming issues: suggestions kept consistent with them; "Defer to #N" option under guardrails | words | review-agent-pr, address-pr-review | overridden |
| H6 | 2026.10.06 | Cost of each review recorded where the runtime reports it | guardrail | review-agent-pr | none |
| H7 | 2026.10.06.1 | Table cells with an escaped pipe (`\|`) parsed whole (readiness apply, decisions, validators, findings.json) | guardrail | review-agent-issue, review-agent-pr | none (bug fix) |
| H8 | 2026.10.06.2 | Spec files read to their last line, checked against "(read to line n of n)"; long output read from files in ranges | guardrail | review-agent-pr, review-agent-issue | spec-guess, spec-deviation (expected: up); late-find |
| H9 | 2026.10.06.3 | Linked issues saved as trimmed background (no tracking issue, no PR review traffic), searched rather than read whole | guardrail | review-agent-pr, review-agent-issue | cost |
| H10 | 2026.10.06.3 | Readiness: prescribed read-only commands run first; edits and assumptions checked against instruction-file rules; option text claims only what it covers; placements marked required or suggestion | words | review-agent-issue | spec-deviation, spec-guess, claim-beyond-evidence |
| H11 | 2026.10.06.3 | CI summary drops cancelled check runs that a later run of the same check replaced | guardrail | review-agent-pr | none (bug fix) |
| H12 | 2026.10.08 | Readiness apply keeps what it dropped: edits that add `##` sections, each assumption's "Makes stale" lines, the Reuse pointers, the options not chosen | guardrail | review-agent-issue | spec-deviation, duplication, stale-restatement |
| H13 | 2026.10.08 | Readiness questions carry a required "Edges" line (boundaries, concurrent calls, edit-and-assumption cases, evidence artifact, complete or minimum lists), checked and copied into the issue | guardrail | review-agent-issue | spec-guess, spec-open (escaped questions) |
| H14 | 2026.10.08 | Only files relied on as a whole are read to their end (brief, manifest, the task's own spec for the spec-working readers); cost recorded by phase | guardrail | review-agent-pr, review-agent-issue | cost |
| H15 | 2026.10.08 | Decided options test every branch they add; fixes that set a number name the numbers it must agree with | words | address-pr-review, review-agent-pr | fix-introduced |
| H16 | 2026.10.08 | Measurement: denominator per class, a within-chance check, no verdict across an "expected: up" reviewer change | guardrail | improve-agent-process | none (measurement) |
| H18 | 2026.10.08.1 | Run record per review round: orchestrator and each subagent's model, effort, tokens and time, in `run.json`, the report's cost table and a hidden run line; labelled comparison runs; model choice per run | guardrail | review-agent-pr, improve-agent-process | none (measurement) |
| H17 | 2026.10.08 | Fixes: CI summary groups runs by check, workflow and event; findings.json without root-cause.md; "None." minor-table row; tracked classes from tables and lists; line counts by either wc or awk | guardrail | review-agent-pr, review-agent-issue | none (bug fix) |
